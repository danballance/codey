const { getDefaultConfig } = require("expo/metro-config");

// Keep Expo's workspace/package resolution, adding raw YAML source imports.
const config = getDefaultConfig(__dirname);
config.transformer.babelTransformerPath = require.resolve('./metro-yaml-transformer');
config.resolver.assetExts = config.resolver.assetExts.filter((extension) => !['yaml', 'yml'].includes(extension));
config.resolver.sourceExts = [...config.resolver.sourceExts, 'yaml', 'yml'];

module.exports = config;
