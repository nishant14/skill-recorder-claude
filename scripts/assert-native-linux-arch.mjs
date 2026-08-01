const requestedArch = process.argv[2];
if (requestedArch !== "x64" && requestedArch !== "arm64") {
  throw new Error("Usage: node scripts/assert-native-linux-arch.mjs <x64|arm64>");
}

if (process.platform !== "linux" || process.arch !== requestedArch) {
  throw new Error(
    `Linux ${requestedArch} packages must be built with ${requestedArch} Node.js on ${requestedArch} Linux. ` +
      `The current host is ${process.platform}-${process.arch}; cross-packaging would embed native dependencies for the wrong architecture.`,
  );
}
