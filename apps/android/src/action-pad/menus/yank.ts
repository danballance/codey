import type { ActionMenuDefinition } from "./types";

export const YANK_MENU = {
  label: "Yank",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "yank-line",
          label: "Line",
          tap: { type: "input", nvimInput: "<Esc>yy<Esc>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
