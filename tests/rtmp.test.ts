import { describe, it, expect } from "bun:test";
import {
  rtmpStreamPath,
  ngrokApiPort,
  waitForNgrok,
  startNgrokTcpTunnel,
} from "../src/rtmp.ts";

describe("rtmpStreamPath (extra cases)", () => {
  it("strips multiple leading slashes", () => {
    expect(rtmpStreamPath("rtmp://host:1935//live/call")).toBe("live/call");
  });
});

describe("ngrokApiPort", () => {
  it("returns first port that responds", async () => {
    const tried: string[] = [];
    const fakeFetch = async (url: string) => {
      tried.push(url);
      if (url.includes(":4041")) {
        return new Response("{}", { status: 200 });
      }
      throw new Error("refused");
    };
    const port = await ngrokApiPort(fakeFetch);
    expect(port).toBe(4041);
  });

  it("defaults to 4040 when none respond", async () => {
    const fakeFetch = async () => {
      throw new Error("refused");
    };
    expect(await ngrokApiPort(fakeFetch)).toBe(4040);
  });
});

describe("waitForNgrok", () => {
  it("returns tunnel matching the port", async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes("/api/tunnels")) {
        return new Response(
          JSON.stringify({
            tunnels: [
              { public_url: "https://other.ngrok.io", config: { addr: "9999" } },
              { public_url: "https://match.ngrok.io", config: { addr: "localhost:8080" } },
            ],
          }),
          { status: 200 },
        );
      }
      throw new Error("refused");
    };
    const url = await waitForNgrok(8080, 5, fakeFetch);
    expect(url).toBe("https://match.ngrok.io");
  });

  it("falls back to first tunnel", async () => {
    const fakeFetch = async (url: string) => {
      if (url.includes("/api/tunnels")) {
        return new Response(
          JSON.stringify({
            tunnels: [{ public_url: "https://first.ngrok.io", config: { addr: "1" } }],
          }),
          { status: 200 },
        );
      }
      throw new Error("refused");
    };
    expect(await waitForNgrok(8080, 5, fakeFetch)).toBe("https://first.ngrok.io");
  });
});

describe("startNgrokTcpTunnel", () => {
  it("returns public_url on success", async () => {
    const fakeFetch = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(
          JSON.stringify({ public_url: "tcp://0.tcp.ngrok.io:12345" }),
          { status: 201 },
        );
      }
      return new Response("{}", { status: 200 });
    };
    expect(await startNgrokTcpTunnel(1935, fakeFetch)).toBe(
      "tcp://0.tcp.ngrok.io:12345",
    );
  });

  it("returns null on ERR_NGROK_8013 (card required)", async () => {
    const fakeFetch = async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response("ERR_NGROK_8013 credit or debit card required", {
          status: 502,
        });
      }
      return new Response("{}", { status: 200 });
    };
    expect(await startNgrokTcpTunnel(1935, fakeFetch)).toBeNull();
  });
});
