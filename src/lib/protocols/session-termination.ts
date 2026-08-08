const SESSION_TERMINATION_TIMEOUT_MS = 1_000;

interface SessionTerminatingTransport {
  terminateSession(): Promise<void>;
}

/**
 * Attempt the official MCP DELETE handshake without letting an unresponsive
 * seller block local transport cleanup indefinitely.
 */
export async function terminateSessionBestEffort(transport: SessionTerminatingTransport): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const termination = transport.terminateSession().catch(() => {});
  const deadline = new Promise<void>(resolve => {
    timer = setTimeout(resolve, SESSION_TERMINATION_TIMEOUT_MS);
  });
  try {
    await Promise.race([termination, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
