export type GoalNavigation = {
  delivery: "send" | "edit";
  view: "current" | "list";
  page: number;
};

export type StatusNavigation = {
  delivery: "send" | "edit";
  full: boolean;
};

export function parseGoalNavigation(callback: string): GoalNavigation | null {
  if (callback === "quick:goal") {
    return { delivery: "send", view: "current", page: 0 };
  }
  if (callback === "goal:current") {
    return { delivery: "edit", view: "current", page: 0 };
  }
  // COMPATIBILITY(MESSAGE_FACTORY): remove after pre-navigation-refactor messages expire.
  if (callback === "quick:goals") {
    return { delivery: "send", view: "list", page: 0 };
  }
  if (callback.startsWith("goal-page:")) {
    const page = Number(callback.slice("goal-page:".length));
    return { delivery: "edit", view: "list", page: Number.isFinite(page) ? Math.max(0, page) : 0 };
  }
  return null;
}

export function parseStatusNavigation(callback: string): StatusNavigation | null {
  if (callback === "quick:status") {
    return { delivery: "send", full: false };
  }
  // COMPATIBILITY(MESSAGE_FACTORY): remove after pre-navigation-refactor messages expire.
  if (callback === "quick:status_full") {
    return { delivery: "send", full: true };
  }
  if (callback === "status:view:basic") {
    return { delivery: "edit", full: false };
  }
  if (callback === "status:view:full") {
    return { delivery: "edit", full: true };
  }
  return null;
}
