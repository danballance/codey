import type { ActionButton, ActionInteraction, ActionMenu } from "../types";
import type { ActionPadMenuId } from "./ids";
import type {
  ActionMenuDefinition,
  ActionMenuDefinitionButton,
  ActionMenuDefinitionInteraction,
} from "./types";

type ActionMenuDefinitionLookup = Readonly<
  Partial<Record<ActionPadMenuId, ActionMenuDefinition>>
>;

export function resolveActionMenu(
  rootId: ActionPadMenuId,
  definitions: ActionMenuDefinitionLookup,
): ActionMenu {
  const resolvedMenus = new Map<ActionPadMenuId, ActionMenu>();
  const resolutionPath: ActionPadMenuId[] = [];

  function resolveInteraction(
    interaction: ActionMenuDefinitionInteraction,
  ): ActionInteraction {
    if (interaction.type !== "menu") return interaction;

    return {
      type: "menu",
      menu: resolveMenu(interaction.menuId),
      after: interaction.after,
    };
  }

  function resolveButton(button: ActionMenuDefinitionButton): ActionButton {
    const { tap, longPress, ...buttonBase } = button;

    if (tap !== undefined) {
      return {
        ...buttonBase,
        tap: resolveInteraction(tap),
        ...(longPress === undefined
          ? {}
          : { longPress: resolveInteraction(longPress) }),
      };
    }

    if (longPress !== undefined) {
      return {
        ...buttonBase,
        longPress: resolveInteraction(longPress),
      };
    }

    throw new Error("Action menu button must define tap or longPress: " + button.id);
  }

  function resolveMenu(menuId: ActionPadMenuId): ActionMenu {
    const resolvedMenu = resolvedMenus.get(menuId);
    if (resolvedMenu !== undefined) return resolvedMenu;

    const cycleStart = resolutionPath.indexOf(menuId);
    if (cycleStart >= 0) {
      const cycle = [...resolutionPath.slice(cycleStart), menuId].join(" -> ");
      throw new Error("Cyclic action menu reference: " + cycle);
    }

    const definition = definitions[menuId];
    if (definition === undefined) {
      throw new Error("Missing action menu definition: " + menuId);
    }

    resolutionPath.push(menuId);
    try {
      const menu: ActionMenu = {
        label: definition.label,
        groups: definition.groups.map((group) => ({
          id: group.id,
          buttons: group.buttons.map(resolveButton),
        })),
      };

      resolvedMenus.set(menuId, menu);
      return menu;
    } finally {
      resolutionPath.pop();
    }
  }

  return resolveMenu(rootId);
}
