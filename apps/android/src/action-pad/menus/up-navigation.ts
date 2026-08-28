import type { ActionMenuDefinition } from "./types";

export const UP_NAVIGATION_MENU = {
  label: "Up Arrow – Navigation",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "top",
          label: "gg Top",
          tap: { type: "input", nvimInput: "gg", after: "stay" },
        },
        {
          id: "block-up",
          label: "Block Up",
          tap: { type: "input", nvimInput: "{", after: "stay" },
        },
        {
          id: "five-lines-up",
          label: "+5 Lines",
          tap: { type: "input", nvimInput: "5k", after: "stay" },
        },
        {
          id: "ten-lines-up",
          label: "+10 Lines",
          tap: { type: "input", nvimInput: "10k", after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "screen-top",
          label: "H Screen Top",
          tap: { type: "input", nvimInput: "H", after: "stay" },
        },
        {
          id: "half-page-up",
          label: "Half Page Up",
          tap: { type: "input", nvimInput: "<C-u>", after: "stay" },
        },
        {
          id: "full-page-up",
          label: "Full Page Up",
          tap: { type: "input", nvimInput: "<C-b>", after: "stay" },
        },
        {
          id: "back",
          label: "Back",
          tap: { type: "back", after: "stay" },
        },
      ],
    },
  ],
} as const satisfies ActionMenuDefinition;
