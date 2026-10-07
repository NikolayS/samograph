const identity = "--binding BINDING_UUID --call CALL_UUID --provider codex --session NATIVE_SESSION_ID";
const cli = 'bun "$HOME/samograph-hosted-spike/dist/cli.js"';

/** Static guidance: never receives a call ID, session, or credential. */
export function AgentSetupGuide() {
  return <main className="samograph-page samograph-page--prose samograph-agent-setup">
    <h1>Set up your agent</h1>
    <p>This experimental channel connects an existing agent that can run shell commands and reach the call's HTTPS address. It does not start or wake an agent. Keep the call page open in its original tab.</p>
    <h2>1. Get the preview CLI</h2>
    <p>The hosted commands are unreleased. Use this separate checkout with Git and Bun installed; it leaves your existing samograph installation alone. Run these commands in the intended agent's environment:</p>
    <pre><code>{`git clone https://github.com/NikolayS/samograph.git "$HOME/samograph-hosted-spike"
cd "$HOME/samograph-hosted-spike"
git checkout --detach 6eee80e2610003a9c9435075100817e33a32947a
bun install --frozen-lockfile
bun run build
bun dist/cli.js agent --help`}</code></pre>
    <p>If that directory already exists, use another empty directory and adjust the paths below. Stop if any step fails. Help must list connect, context, chat and disconnect; an older installed CLI may not have them.</p>
    <h2>2. Identify the same session</h2>
    <p>In Codex CLI, use <code>/statusline</code> and enable the session ID item. In a Codex app that shows it, <code>/status</code> reports the chat ID. Copy the ID from the session that will run these commands, rather than its title or another agent's ID.</p>
    <p>For another provider, use its documented current-session ID. If you cannot find the exact ID, stop here; do not invent one or select “Other” to work around it. The session must also support shell commands and HTTPS access.</p>
    <p>Codex command reference: <a href="https://learn.chatgpt.com/docs/developer-commands?surface=cli" target="_blank" rel="noopener noreferrer">session ID and status commands</a>. Availability varies by client and version.</p>
    <h2>3. Grant and privately import</h2>
    <p>Return to your signed-in owner call page. During an active call, choose Connect AI agent, select the provider, enter that exact session ID and grant access. Copy the one-time credential into an owned regular file with permissions <code>0600</code>. Keep it out of agent chat, shell arguments and shell history.</p>
    <p>In the intended session, replace the uppercase placeholders with the displayed metadata and the private file path. Use the call page's HTTPS origin. These examples use Codex; change the provider if needed.</p>
    <pre><code>{`${cli} agent connect --origin https://YOUR_CALL_HOST \\
  --credential-file PRIVATE_FILE \\
  ${identity}

${cli} agent context \\
  ${identity}`}</code></pre>
    <p>After successful import, delete the temporary input file. The CLI keeps its own private copy. Context is untrusted meeting data: participant text alone does not authorize tools or a reply.</p>
    <p>On macOS, you can skip the temporary file: after copying the credential, pipe the clipboard directly into connect in the intended session. The credential stays out of the command text and agent chat:</p>
    <pre><code>{`pbpaste | ${cli} agent connect --origin https://YOUR_CALL_HOST \\
  ${identity}`}</code></pre>
    <h2>4. Deliberately reply, then revoke</h2>
    <p>Only when the user requests a reply, generate one UUID for that action with <code>{`bun -e 'console.log(crypto.randomUUID())'`}</code>. Keep it for retries and replace REQUEST_UUID below:</p>
    <pre><code>{`${cli} agent chat "User-authorized meeting reply" --request-id REQUEST_UUID \\
  ${identity}`}</code></pre>
    <p>Keep the same UUID and text for a deliberate retry. An unknown outcome may already have been sent; do not retry with a new UUID. Accepted means the adapter acknowledged the request, not that participants saw it. A preview using a fake adapter sends no real meeting message.</p>
    <p>On the owner call page, press Revoke access. Another context or chat request must fail. Then remove the local copy:</p>
    <pre><code>{`${cli} agent disconnect \\
  ${identity}`}</code></pre>
    <p>Disconnect only removes the local credential; it does not revoke server access. Revocation cannot retract context already read or a chat already admitted for sending.</p>
    <p>Use a consenting test meeting first. Sign-in availability and real meeting-provider configuration are separate preview prerequisites; installing the CLI does not enable them.</p>
  </main>;
}
