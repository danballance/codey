/** @type {import("jest").Config} */
module.exports = {
  preset: "jest-expo",
  roots: ["<rootDir>"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  testPathIgnorePatterns: ["<rootDir>/android/"],
  transformIgnorePatterns: [
    "node_modules/(?!(.pnpm|(jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@shopify/react-native-skia|react-native-reanimated|react-native-worklets|react-native-safe-area-context))",
  ],
  clearMocks: true,
};
