export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // A hosted deployment without a trusted client-address source would rate-limit sign-in on nothing: stop at start, loudly.
  const { assertHostedConfig } = await import("@/lib/auth/hosted-config");
  assertHostedConfig();
}
