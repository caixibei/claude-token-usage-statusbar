#!/usr/bin/env python3
"""usage-toolbar 的本地 SQLite 存储。

按会话 ID 保存用量快照与最近轮次，供 mod 在重启后展示历史会话。
数据库位于 ~/.claude/usage-toolbar/usage.db，只保留最近 20 个会话。
"""

import json
import os
import sqlite3
import sys
import time

DB_DIR = os.path.join(os.path.expanduser("~"), ".claude", "usage-toolbar")
DB_PATH = os.path.join(DB_DIR, "usage.db")
KEEP_SESSIONS = 20
MAX_ROUNDS_PER_SESSION = 100

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  gen_ms INTEGER NOT NULL DEFAULT 0,
  ttft_total_ms INTEGER NOT NULL DEFAULT 0,
  ttft_count INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  context_percent REAL,
  by_model TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS rounds (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  gen_ms INTEGER NOT NULL DEFAULT 0,
  ttft_ms INTEGER,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);

CREATE INDEX IF NOT EXISTS idx_rounds_session_started
  ON rounds(session_id, started_at);
"""


def connect():
    """打开数据库并确保目录、表结构存在；旧表缺少 by_model 时补列。"""
    os.makedirs(DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    columns = [row[1] for row in conn.execute("PRAGMA table_info(sessions)")]
    if "by_model" not in columns:
        conn.execute("ALTER TABLE sessions ADD COLUMN by_model TEXT NOT NULL DEFAULT '{}'")
    return conn


def as_int(value, default=0):
    """把 JSON 里的数字安全转成整数，缺失或非法时用默认值。"""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def as_float(value):
    """把 JSON 里的数字安全转成浮点数，缺失或非法时返回 None。"""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def save(payload):
    """写入或更新一个会话的累计与轮次。"""
    session_id = str(payload.get("sessionId") or "")
    if not session_id:
        raise ValueError("missing sessionId")

    totals = payload.get("totals") or {}
    rounds = (payload.get("rounds") or [])[-MAX_ROUNDS_PER_SESSION:]
    updated_at = as_int(payload.get("updatedAt"), int(time.time() * 1000))

    conn = connect()
    with conn:
        conn.execute(
            """
            INSERT INTO sessions (
              session_id, updated_at, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, requests, turns,
              gen_ms, ttft_total_ms, ttft_count, cost_usd, context_percent, by_model
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET
              updated_at=excluded.updated_at,
              input_tokens=excluded.input_tokens,
              output_tokens=excluded.output_tokens,
              cache_read_tokens=excluded.cache_read_tokens,
              cache_creation_tokens=excluded.cache_creation_tokens,
              requests=excluded.requests,
              turns=excluded.turns,
              gen_ms=excluded.gen_ms,
              ttft_total_ms=excluded.ttft_total_ms,
              ttft_count=excluded.ttft_count,
              cost_usd=excluded.cost_usd,
              context_percent=excluded.context_percent,
              by_model=excluded.by_model
            """,
            (
                session_id,
                updated_at,
                as_int(totals.get("inputTokens")),
                as_int(totals.get("outputTokens")),
                as_int(totals.get("cacheReadTokens")),
                as_int(totals.get("cacheCreationTokens")),
                as_int(totals.get("requests")),
                as_int(totals.get("turns")),
                as_int(totals.get("genMs")),
                as_int(totals.get("ttftTotalMs")),
                as_int(totals.get("ttftCount")),
                as_float(payload.get("costUsd")),
                as_float(payload.get("contextPercent")),
                json.dumps(totals.get("byModel") or {}, ensure_ascii=False, separators=(",", ":")),
            ),
        )

        for item in rounds:
            conn.execute(
                """
                INSERT INTO rounds (
                  session_id, turn_id, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_creation_tokens, duration_ms,
                  gen_ms, ttft_ms, started_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(session_id, turn_id) DO UPDATE SET
                  model=excluded.model,
                  input_tokens=excluded.input_tokens,
                  output_tokens=excluded.output_tokens,
                  cache_read_tokens=excluded.cache_read_tokens,
                  cache_creation_tokens=excluded.cache_creation_tokens,
                  duration_ms=excluded.duration_ms,
                  gen_ms=excluded.gen_ms,
                  ttft_ms=excluded.ttft_ms,
                  started_at=excluded.started_at
                """,
                (
                    session_id,
                    str(item.get("turnId") or ""),
                    str(item.get("model") or "unknown"),
                    as_int(item.get("inputTokens")),
                    as_int(item.get("outputTokens")),
                    as_int(item.get("cacheReadTokens")),
                    as_int(item.get("cacheCreationTokens")),
                    as_int(item.get("durationMs")),
                    as_int(item.get("genMs")),
                    None if item.get("ttftMs") is None else as_int(item.get("ttftMs")),
                    as_int(item.get("startedAt")),
                ),
            )

        # 只保留最近 KEEP_SESSIONS 个会话，删除更早的会话与其轮次。
        conn.execute(
            """
            DELETE FROM rounds WHERE session_id NOT IN (
              SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT ?
            )
            """,
            (KEEP_SESSIONS,),
        )
        conn.execute(
            """
            DELETE FROM sessions WHERE session_id NOT IN (
              SELECT session_id FROM sessions ORDER BY updated_at DESC LIMIT ?
            )
            """,
            (KEEP_SESSIONS,),
        )

    conn.close()
    return {"ok": True, "db": DB_PATH}


def load(limit=20):
    """按更新时间倒序返回最近会话及其轮次。"""
    conn = connect()
    limit = max(1, min(as_int(limit, 20), 50))
    session_rows = conn.execute(
        "SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", (limit,)
    ).fetchall()

    result = []
    for session in session_rows:
        round_rows = conn.execute(
            "SELECT * FROM rounds WHERE session_id=? ORDER BY started_at ASC",
            (session["session_id"],),
        ).fetchall()
        try:
            by_model = json.loads(session["by_model"] or "{}")
        except json.JSONDecodeError:
            by_model = {}

        result.append(
            {
                "sessionId": session["session_id"],
                "updatedAt": session["updated_at"],
                "costUsd": session["cost_usd"],
                "contextPercent": session["context_percent"],
                "totals": {
                    "inputTokens": session["input_tokens"],
                    "outputTokens": session["output_tokens"],
                    "cacheReadTokens": session["cache_read_tokens"],
                    "cacheCreationTokens": session["cache_creation_tokens"],
                    "requests": session["requests"],
                    "turns": session["turns"],
                    "genMs": session["gen_ms"],
                    "ttftTotalMs": session["ttft_total_ms"],
                    "ttftCount": session["ttft_count"],
                    "byModel": by_model,
                },
                "rounds": [
                    {
                        "turnId": item["turn_id"],
                        "model": item["model"],
                        "inputTokens": item["input_tokens"],
                        "outputTokens": item["output_tokens"],
                        "cacheReadTokens": item["cache_read_tokens"],
                        "cacheCreationTokens": item["cache_creation_tokens"],
                        "durationMs": item["duration_ms"],
                        "genMs": item["gen_ms"],
                        "ttftMs": item["ttft_ms"],
                        "startedAt": item["started_at"],
                    }
                    for item in round_rows
                ],
            }
        )

    conn.close()
    return result


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: usage_store.py save|load [limit]"}, ensure_ascii=False))
        return 2

    command = sys.argv[1]
    try:
        if command == "save":
            payload = json.load(sys.stdin)
            print(json.dumps(save(payload), ensure_ascii=False))
            return 0
        if command == "load":
            limit = as_int(sys.argv[2], 20) if len(sys.argv) > 2 else 20
            print(json.dumps(load(limit), ensure_ascii=False))
            return 0
        print(json.dumps({"error": f"unknown command: {command}"}, ensure_ascii=False))
        return 2
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
