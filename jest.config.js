export default {
  preset: "ts-jest/presets/default-esm",
  extensionsToTreatAsEsm: [".ts"],
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {
      useESM: true
    }],
  },
  setupFiles: ["<rootDir>/test/setup-env.ts"],
  testTimeout: 30000,
};