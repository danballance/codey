import type { ActionMenuDefinition } from "./types";

export const DOWN_NAVIGATION_MENU = {
  label: "Down Arrow – Navigation",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "bottom",
          label: "G Bottom",
          tap: { type: "input", nvimInput: "G", after: "stay" },
        },
        {
          id: "block-down",
          label: "Block Down",
          tap: { type: "input", nvimInput: "}", after: "stay" },
        },
        {
          id: "five-lines-down",
          label: "+5 Lines",
          tap: { type: "input", nvimInput: "5j", after: "stay" },
        },
        {
          id: "ten-lines-down",
          label: "+10 Lines",
          tap: { type: "input", nvimInput: "10j", after: "stay" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "screen-bottom",
          label: "L Screen Bot",
          tap: { type: "input", nvimInput: "L", after: "stay" },
        },
        {
          id: "half-page-down",
          label: "Half Page Down",
          tap: { type: "input", nvimInput: "<C-d>", after: "stay" },
        },
        {
          id: "full-page-down",
          label: "Full Page Down",
          tap: { type: "input", nvimInput: "<C-f>", after: "stay" },
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
