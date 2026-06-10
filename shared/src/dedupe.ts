export function normalizeFacebookUrl(rawUrl: string): string {
  if (!rawUrl) return "";
  try {
    const url = new URL(rawUrl, "https://www.facebook.com");
    const keep = new URLSearchParams();
    for (const key of ["fbid", "story_fbid", "set", "group_id", "id"]) {
      const value = url.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    url.hash = "";
    url.search = keep.toString();
    return url.toString().replace(/\/$/, "");
  } catch {
    return rawUrl.trim();
  }
}

export function extractFacebookIds(rawUrl: string): string[] {
  const normalized = normalizeFacebookUrl(rawUrl);
  const ids = new Set<string>();
  try {
    const url = new URL(normalized);
    for (const key of ["fbid", "story_fbid", "group_id", "id"]) {
      const value = url.searchParams.get(key);
      if (value) ids.add(`${key}:${value}`);
    }
    const set = url.searchParams.get("set");
    const pcb = set?.match(/pcb\.(\d+)/);
    if (pcb) ids.add(`pcb:${pcb[1]}`);
  } catch {
    // keep best-effort ids only
  }
  return [...ids];
}

export function stableHash(value: string): string {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function dedupeKey(post: {
  postId?: string;
  postUrl?: string;
  postText?: string;
  groupName?: string;
  rawTimeText?: string;
}): string {
  if (post.postId) return `post:${post.postId}`;
  const ids = extractFacebookIds(post.postUrl || "");
  if (ids.length > 0) return ids[0];
  const normalizedUrl = normalizeFacebookUrl(post.postUrl || "");
  if (normalizedUrl) return `url:${normalizedUrl}`;
  return `hash:${stableHash([post.postText, post.groupName, post.rawTimeText].join("|"))}`;
}
