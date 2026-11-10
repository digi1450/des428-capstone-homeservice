// Next 14 may continue serving after a register rejection: boot failure must terminate.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const {startTelemetry}=await import('./lib/telemetry/start.js');
      startTelemetry();
      const {startApplication}=await import('./lib/runtime/startup.js');
      await startApplication();
    } catch {
      // Do not print configuration errors/URLs that may contain credentials.
      console.error('Application startup failed; refusing to serve requests. Check runtime configuration and database compatibility.');
      process.exit(1);
    }
  }
}
