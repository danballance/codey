jest.mock("react-native-worklets", () =>
  require("react-native-worklets/lib/module/mock"),
);

require("react-native-reanimated").setUpTests();

// Expo view registration needs a native app. Keep integration tests focused on
// bridge inputs; the wrapper contract and Android layout have dedicated tests.
jest.mock("./src/native/CodeyActionButtonLabel");
