export function desktopSmokeStage(stage: string): void {
  if (process.argv.includes("--smoke-test")) process.stderr.write(`VIRON_DESKTOP_SMOKE_STAGE ${stage}\n`);
}
