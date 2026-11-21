import "./server-only";
import http from "node:http";
import https from "node:https";
import { stampPeerHeader } from "./client-address";

const INSTALLED = Symbol.for("delulu.peerStampInstalled");

/**
 * Stamps every incoming request with its TCP peer address (client-address.ts), replacing whatever
 * the client sent in that header. Installed once per process by instrumentation.ts, before the
 * server handles requests.
 */
export function installPeerStamp(): void {
  const holder = globalThis as unknown as Record<symbol, boolean | undefined>;
  if (holder[INSTALLED]) return;
  holder[INSTALLED] = true;
  for (const proto of new Set([http.Server.prototype, https.Server.prototype])) {
    const original = proto.emit;
    proto.emit = function emit(this: unknown, event: string | symbol, ...args: unknown[]): boolean {
      if (event === "request") {
        const request = args[0] as http.IncomingMessage;
        stampPeerHeader(request.headers, request.socket?.remoteAddress);
      }
      return Reflect.apply(original, this, [event, ...args]) as boolean;
    } as typeof original;
  }
}
