"use client";

import { useEffect, useState } from "react";
import { api, type UserInfo } from "./api";

let cached: UserInfo | null = null;
let inflight: Promise<UserInfo | null> | null = null;

export function fetchMe(force = false): Promise<UserInfo | null> {
  if (cached && !force) return Promise.resolve(cached);
  if (!inflight || force) {
    inflight = api<UserInfo>("/api/me")
      .then((u) => {
        cached = u;
        return u;
      })
      .catch(() => {
        cached = null;
        return null;
      });
  }
  return inflight;
}

export function resetMe() {
  cached = null;
  inflight = null;
}

export function useUser(): UserInfo | null {
  const [user, setUser] = useState<UserInfo | null>(cached);
  useEffect(() => {
    if (!cached) fetchMe().then(setUser);
  }, []);
  return user;
}
