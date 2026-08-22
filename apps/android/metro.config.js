const { getDefaultConfig } = require("expo/metro-config");

// Expo SDK 57 discovers the pnpm workspace and follows package exports by
// default. Keeping this configuration standard is important: the shared
// @codey packages intentionally export their TypeScript sources to Metro.
module.exports = getDefaultConfig(__dirname);
