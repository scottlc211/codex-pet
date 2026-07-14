export const isTauriRuntime =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function releaseTauriListener(listener: Promise<() => void>) {
  void listener.then((unlisten) => unlisten()).catch(() => undefined);
}
