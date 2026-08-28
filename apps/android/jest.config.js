/** @type {import("jest").Config} */
module.exports = {
  preset: "jest-expo",
  roots: ["<rootDir>"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  transform: {
    '^.+\\.ya?ml$': '<rootDir>/jest-yaml-transformer.js',
    ...require('jest-expo/jest-preset').transform,
  },
  testPathIgnorePatterns: ["<rootDir>/android/"],
  transformIgnorePatterns: [
    "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@shopify/react-native-skia|react-native-reanimated|react-native-worklets|react-native-safe-area-context|yaml))",
  ],
  clearMocks: true,
};
