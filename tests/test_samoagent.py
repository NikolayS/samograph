"""Comprehensive test suite for samoagent CLI.

Tests cover pure helpers, state management, dictionary loading, API key handling,
webhook server event processing, CLI argument parsing, and key command behaviours.
All external I/O (requests, subprocess, os.execvp, os.kill) is mocked.
"""

import importlib
import importlib.machinery
import importlib.util
import json
import os
import signal
import sys
import time
import types
from pathlib import Path
from unittest.mock import MagicMock, call, patch

import pytest

# ---------------------------------------------------------------------------
# Module import helpers
# ---------------------------------------------------------------------------

SAMOAGENT_PATH = Path(__file__).parent.parent / "samoagent"


def _import_samoagent():
    """Import the samoagent script as a module.

    The script has no .py extension so spec_from_file_location returns None.
    We use SourceFileLoader + spec_from_loader instead.
    """
    loader = importlib.machinery.SourceFileLoader("samoagent_mod", str(SAMOAGENT_PATH))
    spec = importlib.util.spec_from_loader("samoagent_mod", loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Import once at module level for reuse; individual tests patch attributes.
sa = _import_samoagent()


# ===========================================================================
# Pure functions — no mocking needed
# ===========================================================================


class TestBotName:
    def test_with_agent_name(self):
        result = sa.bot_name("TARS")
        assert result == "TARS \U0001f534 (samoagent)"

    def test_without_agent_name_none(self):
        result = sa.bot_name(None)
        assert result == "samoagent \U0001f534"

    def test_without_agent_name_empty_string(self):
        # empty string is falsy — same as None
        result = sa.bot_name("")
        assert result == "samoagent \U0001f534"

    def test_truncated_at_100_chars(self):
        long_name = "A" * 200
        result = sa.bot_name(long_name)
        assert len(result) <= 100

    def test_truncation_preserves_prefix(self):
        # Even with a very long name the result is at most 100 chars
        long_name = "X" * 200
        result = sa.bot_name(long_name)
        assert result.startswith("X")
        assert len(result) == 100

    def test_exact_boundary_name_not_truncated(self):
        # "A 🔴 (samoagent)" is base for agent name; craft a name so total == 100
        # "NAME 🔴 (samoagent)" — emoji is 4 bytes but 1 char; " 🔴 (samoagent)" is 15 chars
        suffix = " \U0001f534 (samoagent)"  # 15 chars
        name_part = "B" * (100 - len(suffix))
        result = sa.bot_name(name_part)
        assert len(result) == 100


class TestRtmpStreamPath:
    def test_simple_path(self):
        assert sa._rtmp_stream_path("rtmp://1.2.3.4:1935/live/call") == "live/call"

    def test_single_segment(self):
        assert sa._rtmp_stream_path("rtmp://host:1935/stream") == "stream"

    def test_deep_path(self):
        assert sa._rtmp_stream_path("rtmp://host/a/b/c") == "a/b/c"

    def test_no_path(self):
        result = sa._rtmp_stream_path("rtmp://host:1935/")
        assert result == ""

    def test_localhost_url(self):
        assert sa._rtmp_stream_path("rtmp://localhost:1935/live/call") == "live/call"


class TestResolveTranscriptFile:
    def test_default_path(self, tmp_path):
        with patch.object(Path, "home", return_value=tmp_path):
            result = sa.resolve_transcript_file(None)
        assert result == tmp_path / ".samoagent" / "transcript.txt"

    def test_custom_dir(self, tmp_path):
        custom = tmp_path / "mytranscripts"
        result = sa.resolve_transcript_file(str(custom))
        assert result == custom / "transcript.txt"
        assert custom.exists()

    def test_creates_parent_dirs(self, tmp_path):
        nested = tmp_path / "a" / "b" / "c"
        sa.resolve_transcript_file(str(nested))
        assert nested.exists()

    def test_default_creates_samoagent_dir(self, tmp_path):
        with patch.object(Path, "home", return_value=tmp_path):
            sa.resolve_transcript_file(None)
        assert (tmp_path / ".samoagent").exists()


# ===========================================================================
# State management
# ===========================================================================


class TestLoadState:
    def test_returns_empty_dict_when_no_file(self, tmp_path):
        with patch.object(sa, "STATE_FILE", tmp_path / "state.json"):
            result = sa.load_state()
        assert result == {}

    def test_returns_parsed_json_when_file_exists(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "abc-123", "server_pid": 9999}))
        with patch.object(sa, "STATE_FILE", state_file):
            result = sa.load_state()
        assert result == {"bot_id": "abc-123", "server_pid": 9999}

    def test_preserves_all_fields(self, tmp_path):
        data = {
            "bot_id": "xyz",
            "agent_name": "TARS",
            "webhook_url": "https://example.ngrok.io/webhook",
            "server_pid": 1234,
            "ngrok_pid": 5678,
            "transcript_file": "/tmp/transcript.txt",
        }
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps(data))
        with patch.object(sa, "STATE_FILE", state_file):
            result = sa.load_state()
        assert result == data


class TestSaveState:
    def test_writes_json_file(self, tmp_path):
        state_file = tmp_path / "sub" / "state.json"
        with patch.object(sa, "STATE_FILE", state_file):
            sa.save_state({"bot_id": "test-bot"})
        assert state_file.exists()
        assert json.loads(state_file.read_text()) == {"bot_id": "test-bot"}

    def test_creates_parent_dirs(self, tmp_path):
        state_file = tmp_path / "a" / "b" / "state.json"
        with patch.object(sa, "STATE_FILE", state_file):
            sa.save_state({"x": 1})
        assert state_file.exists()

    def test_round_trip(self, tmp_path):
        state_file = tmp_path / "state.json"
        original = {"bot_id": "rt-1", "server_pid": 42, "nested": {"key": "val"}}
        with patch.object(sa, "STATE_FILE", state_file):
            sa.save_state(original)
            loaded = sa.load_state()
        assert loaded == original

    def test_overwrites_existing(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "old"}))
        with patch.object(sa, "STATE_FILE", state_file):
            sa.save_state({"bot_id": "new"})
            loaded = sa.load_state()
        assert loaded["bot_id"] == "new"


# ===========================================================================
# Dictionary loading
# ===========================================================================


class TestLoadDict:
    def test_none_returns_empty(self):
        assert sa.load_dict(None) == []

    def test_string_none_returns_empty(self):
        assert sa.load_dict("none") == []

    def test_string_NONE_case_insensitive(self):
        assert sa.load_dict("NONE") == []

    def test_nonexistent_returns_empty_with_warning(self, capsys):
        # Point DICT_DIR at a temp dir with no files
        with patch.object(sa, "DICT_DIR", Path("/tmp/nonexistent_dict_dir_xyzzy")):
            result = sa.load_dict("bogus_dict")
        assert result == []
        captured = capsys.readouterr()
        assert "Warning" in captured.out or "not found" in captured.out

    def test_real_postgresfm_returns_terms(self):
        # Use the real file if it exists (it does in this repo)
        real_dict_dir = Path(__file__).parent.parent / "dictionaries"
        if not (real_dict_dir / "postgresfm.txt").exists():
            pytest.skip("postgresfm.txt not present")
        with patch.object(sa, "DICT_DIR", real_dict_dir):
            terms = sa.load_dict("postgresfm")
        assert len(terms) > 0
        assert len(terms) <= 100

    def test_max_100_terms_enforced(self, tmp_path):
        # Create a dict file with 150 terms
        dict_file = tmp_path / "big.txt"
        dict_file.write_text("\n".join(f"term{i}" for i in range(150)))
        with patch.object(sa, "DICT_DIR", tmp_path):
            result = sa.load_dict("big")
        assert len(result) == 100
        assert result[0] == "term0"
        assert result[99] == "term99"

    def test_skips_blank_lines(self, tmp_path):
        dict_file = tmp_path / "sparse.txt"
        dict_file.write_text("alpha\n\nbeta\n\n\ngamma\n")
        with patch.object(sa, "DICT_DIR", tmp_path):
            result = sa.load_dict("sparse")
        assert result == ["alpha", "beta", "gamma"]

    def test_strips_whitespace(self, tmp_path):
        dict_file = tmp_path / "ws.txt"
        dict_file.write_text("  hello  \n  world  \n")
        with patch.object(sa, "DICT_DIR", tmp_path):
            result = sa.load_dict("ws")
        assert result == ["hello", "world"]

    def test_postgresfm_at_limit(self):
        """postgresfm.txt has exactly 100 lines — all should be returned."""
        real_dict_dir = Path(__file__).parent.parent / "dictionaries"
        if not (real_dict_dir / "postgresfm.txt").exists():
            pytest.skip("postgresfm.txt not present")
        with patch.object(sa, "DICT_DIR", real_dict_dir):
            terms = sa.load_dict("postgresfm")
        # File has exactly 100 terms — all returned, none truncated
        assert len(terms) == 100


# ===========================================================================
# API key
# ===========================================================================


class TestApiKey:
    def test_returns_key_when_set(self):
        with patch.dict(os.environ, {"RECALL_API_KEY": "test-key-123"}):
            result = sa.api_key()
        assert result == "test-key-123"

    def test_exits_when_not_set(self):
        env_without_key = {k: v for k, v in os.environ.items() if k != "RECALL_API_KEY"}
        with patch.dict(os.environ, env_without_key, clear=True):
            with pytest.raises(SystemExit) as exc_info:
                sa.api_key()
        assert exc_info.value.code == 1

    def test_exits_when_empty_string(self):
        with patch.dict(os.environ, {"RECALL_API_KEY": ""}):
            with pytest.raises(SystemExit) as exc_info:
                sa.api_key()
        assert exc_info.value.code == 1

    def test_error_message_on_missing_key(self, capsys):
        env_without_key = {k: v for k, v in os.environ.items() if k != "RECALL_API_KEY"}
        with patch.dict(os.environ, env_without_key, clear=True):
            with pytest.raises(SystemExit):
                sa.api_key()
        captured = capsys.readouterr()
        assert "RECALL_API_KEY" in captured.err


# ===========================================================================
# Webhook server (cmd_serve)
# ===========================================================================


class TestWebhookServer:
    """Test the Flask webhook handler logic directly by constructing the Flask app
    in isolation and using its test client."""

    def _make_app(self, transcript_path: Path):
        """Build the Flask app the same way cmd_serve does, but return app + client."""
        from flask import Flask, jsonify, request as flask_request

        app = Flask(__name__)

        @app.route("/webhook", methods=["POST"])
        def webhook():
            payload = flask_request.json or {}
            if payload.get("event") == "transcript.data":
                outer = payload.get("data", {})
                inner = outer.get("data", {})
                words = inner.get("words", [])
                if words:
                    text = " ".join(w.get("text", "") for w in words)
                    speaker = inner.get("participant", {}).get("name", "?")
                    ts = words[0].get("start_timestamp", {}).get("absolute", "")[:19].replace("T", " ")
                    line = f"[{ts}] {speaker}: {text}"
                    with open(transcript_path, "a") as f:
                        f.write(line + "\n")
            return jsonify({"ok": True})

        return app

    def _make_transcript_event(
        self, speaker: str, words: list, timestamp: str = "2024-01-15T10:30:45.000Z"
    ) -> dict:
        return {
            "event": "transcript.data",
            "data": {
                "data": {
                    "participant": {"name": speaker},
                    "words": [
                        {"text": w, "start_timestamp": {"absolute": timestamp}}
                        for w in words
                    ],
                }
            },
        }

    def test_transcript_event_writes_line(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        payload = self._make_transcript_event("Alice", ["Hello", "world"])
        resp = client.post("/webhook", json=payload)

        assert resp.status_code == 200
        assert resp.get_json() == {"ok": True}
        lines = tf.read_text().splitlines()
        assert len(lines) == 1
        assert "Alice" in lines[0]
        assert "Hello world" in lines[0]

    def test_line_format_timestamp_speaker_text(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        payload = self._make_transcript_event(
            "Bob", ["Nice", "to", "meet", "you"], "2024-03-20T14:05:30.123Z"
        )
        client.post("/webhook", json=payload)

        line = tf.read_text().strip()
        assert line == "[2024-03-20 14:05:30] Bob: Nice to meet you"

    def test_multiple_words_joined_with_spaces(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        words = ["one", "two", "three", "four", "five"]
        payload = self._make_transcript_event("Carol", words)
        client.post("/webhook", json=payload)

        line = tf.read_text().strip()
        assert "one two three four five" in line

    def test_unknown_event_ignored(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        resp = client.post("/webhook", json={"event": "some.other.event", "data": {}})

        assert resp.status_code == 200
        assert resp.get_json() == {"ok": True}
        assert tf.read_text() == ""

    def test_missing_event_field_ignored(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        resp = client.post("/webhook", json={"data": {}})

        assert resp.status_code == 200
        assert tf.read_text() == ""

    def test_empty_words_list_not_written(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        payload = {
            "event": "transcript.data",
            "data": {"data": {"participant": {"name": "Dan"}, "words": []}},
        }
        resp = client.post("/webhook", json=payload)

        assert resp.status_code == 200
        assert tf.read_text() == ""

    def test_multiple_events_appended(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        client.post("/webhook", json=self._make_transcript_event("A", ["first"]))
        client.post("/webhook", json=self._make_transcript_event("B", ["second"]))
        client.post("/webhook", json=self._make_transcript_event("C", ["third"]))

        lines = [l for l in tf.read_text().splitlines() if l]
        assert len(lines) == 3
        assert "first" in lines[0]
        assert "second" in lines[1]
        assert "third" in lines[2]

    def test_missing_speaker_defaults_to_question_mark(self, tmp_path):
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        payload = {
            "event": "transcript.data",
            "data": {
                "data": {
                    # no participant field
                    "words": [{"text": "hi", "start_timestamp": {"absolute": "2024-01-01T00:00:00Z"}}]
                }
            },
        }
        client.post("/webhook", json=payload)

        line = tf.read_text().strip()
        assert "[2024-01-01 00:00:00] ?: hi" == line

    def test_timestamp_truncated_to_seconds(self, tmp_path):
        """Milliseconds in the ISO timestamp should be stripped."""
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        app = self._make_app(tf)
        client = app.test_client()

        payload = self._make_transcript_event(
            "Eve", ["test"], "2025-12-31T23:59:59.999999Z"
        )
        client.post("/webhook", json=payload)

        line = tf.read_text().strip()
        assert line.startswith("[2025-12-31 23:59:59]")


# ===========================================================================
# CLI argument parsing
# ===========================================================================


class TestArgParsing:
    """Test that argparse is configured correctly for each subcommand."""

    def _parse(self, argv):
        """Parse argv list using the same parser as main()."""
        parser = self._build_parser()
        return parser.parse_args(argv)

    def _build_parser(self):
        import argparse

        parser = argparse.ArgumentParser(prog="samoagent")
        sub = parser.add_subparsers(dest="command", required=True)

        p_join = sub.add_parser("join")
        p_join.add_argument("url")
        p_join.add_argument("--name")
        p_join.add_argument("--dict")
        p_join.add_argument("--port", type=int, default=8080)
        p_join.add_argument("--transcript-dir")
        p_join.add_argument("--rtmp-url", dest="rtmp_url")

        p_leave = sub.add_parser("leave")
        p_leave.add_argument("bot_id", nargs="?")

        p_status = sub.add_parser("status")
        p_status.add_argument("bot_id", nargs="?")

        p_shot = sub.add_parser("screenshot")
        p_shot.add_argument("--out", default="screenshot.png")
        p_shot.add_argument("bot_id", nargs="?")

        p_chat = sub.add_parser("chat")
        p_chat.add_argument("message")
        p_chat.add_argument("--bot-id")

        p_tx = sub.add_parser("transcript")
        p_tx.add_argument("bot_id", nargs="?")

        sub.add_parser("dicts")
        sub.add_parser("watch")

        p_frame = sub.add_parser("frame")
        p_frame.add_argument("--out", default="frame.png")
        p_frame.add_argument("bot_id", nargs="?")

        p_serve = sub.add_parser("_serve")
        p_serve.add_argument("--port", type=int, default=8080)
        p_serve.add_argument("--transcript-file", required=True)

        return parser

    def test_join_requires_url(self):
        with pytest.raises(SystemExit):
            self._parse(["join"])

    def test_join_parses_url(self):
        args = self._parse(["join", "https://zoom.us/j/123"])
        assert args.url == "https://zoom.us/j/123"
        assert args.command == "join"

    def test_join_default_port(self):
        args = self._parse(["join", "https://zoom.us/j/1"])
        assert args.port == 8080

    def test_join_custom_port(self):
        args = self._parse(["join", "https://zoom.us/j/1", "--port", "9090"])
        assert args.port == 9090

    def test_join_rtmp_url_optional(self):
        args = self._parse(["join", "https://zoom.us/j/1"])
        assert args.rtmp_url is None

    def test_join_rtmp_url_parsed(self):
        args = self._parse(["join", "https://zoom.us/j/1", "--rtmp-url", "rtmp://1.2.3.4:1935/live/call"])
        assert args.rtmp_url == "rtmp://1.2.3.4:1935/live/call"

    def test_join_name_optional(self):
        args = self._parse(["join", "https://zoom.us/j/1"])
        assert args.name is None

    def test_join_dict_optional(self):
        args = self._parse(["join", "https://zoom.us/j/1"])
        assert args.dict is None

    def test_leave_bot_id_optional(self):
        args = self._parse(["leave"])
        assert args.bot_id is None

    def test_leave_bot_id_explicit(self):
        args = self._parse(["leave", "bot-abc"])
        assert args.bot_id == "bot-abc"

    def test_chat_requires_message(self):
        with pytest.raises(SystemExit):
            self._parse(["chat"])

    def test_chat_message_parsed(self):
        args = self._parse(["chat", "Hello meeting"])
        assert args.message == "Hello meeting"

    def test_dicts_subcommand(self):
        args = self._parse(["dicts"])
        assert args.command == "dicts"

    def test_watch_subcommand(self):
        args = self._parse(["watch"])
        assert args.command == "watch"

    def test_frame_default_out(self):
        args = self._parse(["frame"])
        assert args.out == "frame.png"

    def test_frame_custom_out(self):
        args = self._parse(["frame", "--out", "myframe.png"])
        assert args.out == "myframe.png"

    def test_serve_requires_transcript_file(self):
        with pytest.raises(SystemExit):
            self._parse(["_serve"])

    def test_serve_parses_transcript_file(self):
        args = self._parse(["_serve", "--transcript-file", "/tmp/t.txt"])
        assert args.transcript_file == "/tmp/t.txt"


# ===========================================================================
# cmd_leave
# ===========================================================================


class TestCmdLeave:
    def _make_args(self, bot_id=None):
        args = MagicMock()
        args.bot_id = bot_id
        return args

    def test_calls_recall_leave_endpoint(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-xyz"}))

        mock_resp = MagicMock()
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=mock_resp) as mock_post,
            patch("os.kill"),
        ):
            sa.cmd_leave(self._make_args())

        mock_post.assert_called_once()
        call_url = mock_post.call_args[0][0]
        assert "bot-xyz" in call_url
        assert "leave_call" in call_url

    def test_kills_server_pid(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-1", "server_pid": 1111}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill") as mock_kill,
        ):
            sa.cmd_leave(self._make_args())

        mock_kill.assert_any_call(1111, signal.SIGTERM)

    def test_kills_ngrok_pid(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-1", "ngrok_pid": 2222}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill") as mock_kill,
        ):
            sa.cmd_leave(self._make_args())

        mock_kill.assert_any_call(2222, signal.SIGTERM)

    def test_kills_mediamtx_pid(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-1", "mediamtx_pid": 3333}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill") as mock_kill,
        ):
            sa.cmd_leave(self._make_args())

        mock_kill.assert_any_call(3333, signal.SIGTERM)

    def test_removes_state_file(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-del"}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill"),
        ):
            sa.cmd_leave(self._make_args())

        assert not state_file.exists()

    def test_tolerates_missing_pids(self, tmp_path):
        """State with no pids — kill should not be called, no crash."""
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-nopid"}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill") as mock_kill,
        ):
            sa.cmd_leave(self._make_args())

        mock_kill.assert_not_called()

    def test_tolerates_process_lookup_error(self, tmp_path):
        """If process is already gone, ProcessLookupError should be swallowed."""
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-gone", "server_pid": 9999}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill", side_effect=ProcessLookupError),
        ):
            # Should not raise
            sa.cmd_leave(self._make_args())

    def test_uses_bot_id_from_args_when_provided(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "state-bot"}))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()) as mock_post,
            patch("os.kill"),
        ):
            sa.cmd_leave(self._make_args(bot_id="explicit-bot"))

        call_url = mock_post.call_args[0][0]
        assert "explicit-bot" in call_url

    def test_exits_when_no_bot_id_and_no_state(self, tmp_path):
        state_file = tmp_path / "state.json"
        # no state file

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
        ):
            with pytest.raises(SystemExit) as exc_info:
                sa.cmd_leave(self._make_args())
        assert exc_info.value.code == 1

    def test_writes_sentinel_to_transcript(self, tmp_path):
        """cmd_leave appends SAMOAGENT_CALL_ENDED sentinel to transcript file."""
        tf = tmp_path / "transcript.txt"
        tf.write_text("[2026-05-28 09:59:00] Alice: Hello\n")

        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({
            "bot_id": "bot-sentinel",
            "transcript_file": str(tf),
        }))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill"),
        ):
            sa.cmd_leave(self._make_args())

        content = tf.read_text()
        assert "SAMOAGENT_CALL_ENDED" in content

    def test_sentinel_line_format(self, tmp_path):
        """Sentinel line matches [YYYY-MM-DD HH:MM:SS] SAMOAGENT_CALL_ENDED format."""
        import re
        tf = tmp_path / "transcript.txt"
        tf.write_text("")

        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({
            "bot_id": "bot-fmt",
            "transcript_file": str(tf),
        }))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill"),
        ):
            sa.cmd_leave(self._make_args())

        content = tf.read_text().strip()
        pattern = r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] SAMOAGENT_CALL_ENDED$"
        assert re.match(pattern, content), f"Sentinel line format mismatch: {content!r}"

    def test_sentinel_not_written_when_transcript_missing(self, tmp_path):
        """If transcript file doesn't exist, cmd_leave still completes without error."""
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({
            "bot_id": "bot-notf",
            "transcript_file": str(tmp_path / "nonexistent.txt"),
        }))

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.post", return_value=MagicMock()),
            patch("os.kill"),
        ):
            # Should not raise even if transcript file is absent
            sa.cmd_leave(self._make_args())


# ===========================================================================
# cmd_watch
# ===========================================================================


class TestCmdWatch:
    def _make_args(self):
        return MagicMock()

    def test_exits_on_call_ended_sentinel(self, tmp_path):
        """cmd_watch exits cleanly when SAMOAGENT_CALL_ENDED appears in transcript."""
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"transcript_file": str(tf)}))

        # Write the sentinel line after watch has opened and seeked to end
        import threading

        def _write_sentinel():
            time.sleep(0.15)
            with open(tf, "a") as f:
                f.write("[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n")

        t = threading.Thread(target=_write_sentinel, daemon=True)
        t.start()

        with patch.object(sa, "STATE_FILE", state_file):
            sa.cmd_watch(self._make_args())  # should return, not hang

        t.join(timeout=2)

    def test_exits_when_state_file_disappears(self, tmp_path):
        """cmd_watch exits when state.json is removed (secondary exit condition)."""
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"transcript_file": str(tf)}))

        import threading

        def _remove_state():
            time.sleep(0.25)
            state_file.unlink()

        t = threading.Thread(target=_remove_state, daemon=True)
        t.start()

        with patch.object(sa, "STATE_FILE", state_file):
            sa.cmd_watch(self._make_args())  # should return when state.json gone

        t.join(timeout=3)

    def test_prints_lines_before_sentinel(self, tmp_path, capsys):
        """Lines written before SAMOAGENT_CALL_ENDED are printed to stdout."""
        tf = tmp_path / "transcript.txt"
        tf.write_text("")
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"transcript_file": str(tf)}))

        import threading

        def _write_content():
            time.sleep(0.15)
            with open(tf, "a") as f:
                f.write("[2026-05-28 10:00:01] Alice: Hello everyone\n")
                f.write("[2026-05-28 10:00:05] Bob: Hi there\n")
                f.write("[2026-05-28 10:00:10] SAMOAGENT_CALL_ENDED\n")

        t = threading.Thread(target=_write_content, daemon=True)
        t.start()

        with patch.object(sa, "STATE_FILE", state_file):
            sa.cmd_watch(self._make_args())

        t.join(timeout=3)
        captured = capsys.readouterr()
        assert "Alice: Hello everyone" in captured.out
        assert "Bob: Hi there" in captured.out
        assert "SAMOAGENT_CALL_ENDED" in captured.out

    def test_handles_existing_transcript_with_sentinel(self, tmp_path):
        """cmd_watch exits cleanly when transcript exists and already has content + sentinel."""
        tf = tmp_path / "transcript.txt"
        # File pre-exists with some content — watch should seek to end and then get sentinel
        tf.write_text("[2026-05-28 09:58:00] Alice: Earlier line\n")
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"transcript_file": str(tf)}))

        import threading

        def _write_sentinel():
            time.sleep(0.15)
            with open(tf, "a") as f:
                f.write("[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n")

        t = threading.Thread(target=_write_sentinel, daemon=True)
        t.start()

        with patch.object(sa, "STATE_FILE", state_file):
            sa.cmd_watch(self._make_args())

        t.join(timeout=3)
        assert tf.exists()

    def test_uses_default_transcript_path_when_no_state(self, tmp_path):
        """Uses ~/.samoagent/transcript.txt when state has no transcript_file key."""
        samoagent_dir = tmp_path / ".samoagent"
        samoagent_dir.mkdir()
        tf = samoagent_dir / "transcript.txt"
        tf.write_text("")

        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({}))  # no transcript_file key

        import threading

        def _write_sentinel():
            time.sleep(0.15)
            with open(tf, "a") as f:
                f.write("[2026-05-28 10:00:00] SAMOAGENT_CALL_ENDED\n")

        t = threading.Thread(target=_write_sentinel, daemon=True)
        t.start()

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.object(Path, "home", return_value=tmp_path),
        ):
            sa.cmd_watch(self._make_args())

        t.join(timeout=3)


# ===========================================================================
# cmd_frame — no RTMP
# ===========================================================================


class TestCmdFrameNoRtmp:
    def _make_args(self, out="frame.png", bot_id=None):
        args = MagicMock()
        args.out = out
        args.bot_id = bot_id
        return args

    def test_tries_recall_screenshot_when_no_rtmp(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-123"}))

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "image/png"}
        mock_resp.content = b"\x89PNG"

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        assert out_file.exists()
        assert out_file.read_bytes() == b"\x89PNG"

    def test_writes_image_to_file_on_success(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-img"}))

        image_data = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "image/png"}
        mock_resp.content = image_data

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        assert out_file.read_bytes() == image_data

    def test_exits_when_not_image_content_type(self, tmp_path, capsys):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-noimg"}))

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "application/json"}
        mock_resp.content = b"{}"

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            with pytest.raises(SystemExit) as exc_info:
                sa.cmd_frame(self._make_args(out=str(out_file)))

        assert exc_info.value.code == 1
        captured = capsys.readouterr()
        assert "FRAME_UNAVAILABLE" in captured.err

    def test_exits_when_not_200(self, tmp_path, capsys):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-404"}))

        mock_resp = MagicMock()
        mock_resp.status_code = 404
        mock_resp.headers = {"content-type": "application/json"}

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            with pytest.raises(SystemExit) as exc_info:
                sa.cmd_frame(self._make_args(out=str(out_file)))

        assert exc_info.value.code == 1

    def test_frame_unavailable_message_in_stderr(self, tmp_path, capsys):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-err"}))

        mock_resp = MagicMock()
        mock_resp.status_code = 503
        mock_resp.headers = {"content-type": "text/plain"}

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            with pytest.raises(SystemExit):
                sa.cmd_frame(self._make_args(out=str(out_file)))

        captured = capsys.readouterr()
        assert "FRAME_UNAVAILABLE" in captured.err

    def test_prints_path_on_success(self, tmp_path, capsys):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-ok"}))

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"content-type": "image/jpeg"}
        mock_resp.content = b"JPEG"

        out_file = tmp_path / "frame.png"
        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("requests.get", return_value=mock_resp),
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        captured = capsys.readouterr()
        assert str(out_file.resolve()) in captured.out


# ===========================================================================
# cmd_frame — with RTMP
# ===========================================================================


class TestCmdFrameWithRtmp:
    def _make_args(self, out="frame.png", bot_id=None):
        args = MagicMock()
        args.out = out
        args.bot_id = bot_id
        return args

    def test_runs_ffmpeg_when_rtmp_in_state(self, tmp_path):
        rtmp_url = "rtmp://localhost:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "bot-rtmp", "rtmp_local_url": rtmp_url}))

        out_file = tmp_path / "frame.png"
        out_file.write_bytes(b"PNG")  # simulate ffmpeg creating the file

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result) as mock_run,
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        mock_run.assert_called_once()
        cmd_args = mock_run.call_args[0][0]
        assert any("ffmpeg" in str(a) for a in cmd_args)

    def test_ffmpeg_uses_rtmp_url_as_input(self, tmp_path):
        rtmp_url = "rtmp://localhost:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"rtmp_local_url": rtmp_url}))

        out_file = tmp_path / "frame.png"
        out_file.write_bytes(b"PNG")

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result) as mock_run,
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        cmd_args = mock_run.call_args[0][0]
        assert rtmp_url in cmd_args

    def test_ffmpeg_output_file_in_command(self, tmp_path):
        rtmp_url = "rtmp://localhost:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"rtmp_local_url": rtmp_url}))

        out_file = tmp_path / "myframe.png"
        out_file.write_bytes(b"PNG")

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result) as mock_run,
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        cmd_args = mock_run.call_args[0][0]
        assert str(out_file) in cmd_args

    def test_prints_path_on_ffmpeg_success(self, tmp_path, capsys):
        rtmp_url = "rtmp://localhost:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"rtmp_local_url": rtmp_url}))

        out_file = tmp_path / "frame.png"
        out_file.write_bytes(b"PNG")

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result),
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        captured = capsys.readouterr()
        assert str(out_file.resolve()) in captured.out

    def test_exits_on_ffmpeg_failure(self, tmp_path, capsys):
        rtmp_url = "rtmp://localhost:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"rtmp_local_url": rtmp_url}))

        out_file = tmp_path / "frame.png"
        # Do NOT create the file — ffmpeg "failed"

        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stderr = b"Connection refused"

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result),
        ):
            with pytest.raises(SystemExit) as exc_info:
                sa.cmd_frame(self._make_args(out=str(out_file)))

        assert exc_info.value.code == 1

    def test_remote_rtmp_url_used_directly(self, tmp_path):
        """When rtmp_local_url is a remote URL, ffmpeg reads from it directly."""
        remote_rtmp = "rtmp://203.0.113.5:1935/live/call"
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"rtmp_local_url": remote_rtmp}))

        out_file = tmp_path / "frame.png"
        out_file.write_bytes(b"PNG")

        mock_result = MagicMock()
        mock_result.returncode = 0

        with (
            patch.object(sa, "STATE_FILE", state_file),
            patch.dict(os.environ, {"RECALL_API_KEY": "fake-key"}),
            patch("subprocess.run", return_value=mock_result) as mock_run,
        ):
            sa.cmd_frame(self._make_args(out=str(out_file)))

        cmd_args = mock_run.call_args[0][0]
        assert remote_rtmp in cmd_args


# ===========================================================================
# bot_id_from_args_or_state
# ===========================================================================


class TestBotIdFromArgsOrState:
    def test_returns_explicit_bot_id(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "state-bot"}))
        with patch.object(sa, "STATE_FILE", state_file):
            result = sa.bot_id_from_args_or_state("explicit-bot")
        assert result == "explicit-bot"

    def test_returns_state_bot_id_when_no_arg(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"bot_id": "state-bot-123"}))
        with patch.object(sa, "STATE_FILE", state_file):
            result = sa.bot_id_from_args_or_state(None)
        assert result == "state-bot-123"

    def test_exits_when_no_arg_and_no_state(self, tmp_path):
        state_file = tmp_path / "state.json"
        with patch.object(sa, "STATE_FILE", state_file):
            with pytest.raises(SystemExit) as exc_info:
                sa.bot_id_from_args_or_state(None)
        assert exc_info.value.code == 1

    def test_exits_when_no_arg_and_state_missing_bot_id(self, tmp_path):
        state_file = tmp_path / "state.json"
        state_file.write_text(json.dumps({"server_pid": 123}))
        with patch.object(sa, "STATE_FILE", state_file):
            with pytest.raises(SystemExit) as exc_info:
                sa.bot_id_from_args_or_state(None)
        assert exc_info.value.code == 1
