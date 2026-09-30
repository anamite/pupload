import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePrivate, useVault, keys } from "@/lib/queries";
import { useReminders } from "@/lib/reminders";
import { navigate, PRIVATE_VIEWS, type View } from "@/lib/router";

/**
 * The private space (notes, voice memos, lists, calendar) exists only where
 * secure folders are unlocked: a device that entered the master password, or a
 * full remote sign-in. Anywhere else it isn't shown at all.
 */
export function usePrivateAccess(): boolean {
  const { data } = useVault();
  return !!data?.unlocked && !data?.hidden;
}

/** Keeps the private space out of sight once locked, and runs its reminders while open. */
export function PrivateGuard({ view }: { view: View }) {
  const qc = useQueryClient();
  const { data: vault } = useVault();
  const access = !!vault?.unlocked && !vault?.hidden;
  const { data } = usePrivate(access);
  useReminders(data, access);

  React.useEffect(() => {
    if (!vault || access) return;
    // Locked (here, elsewhere, or the unlock ran out): forget the decrypted copy.
    qc.removeQueries({ queryKey: keys.private });
    if (PRIVATE_VIEWS.includes(view)) navigate("files", "", true);
  }, [vault, access, view, qc]);
  return null;
}
