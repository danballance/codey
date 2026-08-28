import type { ActionMenuDefinition } from "./types";

export const DELETE_MENU = {
  label: "Delete",
  groups: [
    {
      id: "leading",
      buttons: [
        {
          id: "delete-num-2",
          label: "2",
          tap: { type: "input", nvimInput: "<Esc>d2", after: "stay" },
          styles: { size: "1/4" },
        },
        {
          id: "delete-num-3",
          label: "3",
          tap: { type: "input", nvimInput: "<Esc>d3", after: "stay" },
          styles: { size: "1/4" },
        },
        {
          id: "delete-num-4",
          label: "4",
          tap: { type: "input", nvimInput: "<Esc>d4", after: "stay" },
          styles: { size: "1/4" },
        },
        {
          id: "delete-num-5",
          label: "5",
          tap: { type: "input", nvimInput: "<Esc>d5", after: "stay" },
          styles: { size: "1/4" },
        },
        {
          id: "delete-word-back-start",
          label: "⬅ word start",
          tap: { type: "input", nvimInput: "b", after: "root" },
        },
      ],
    },
    {
      id: "trailing",
      buttons: [
        {
          id: "delete-line",
          label: "Line",
          tap: { type: "input", nvimInput: "<Esc>dd<Esc>", after: "root" },
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
