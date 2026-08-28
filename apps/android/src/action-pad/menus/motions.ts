import type { ActionMenuDefinition } from "./types";

export const MOTIONS_MENU = {
  label: "Motions",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "save",
          label: "Save",
          tap: { type: "input", nvimInput: ":w<CR>", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "write-quit",
          label: "Write and Quit",
          tap: { type: "input", nvimInput: ":wq<CR>", after: "root" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
