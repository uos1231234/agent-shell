#!/usr/bin/env python3
"""
agent-shell RAG entry point (v0.10.2).

Invoked by Node via child_process.spawn. Two subcommands:

  embed.py embed        # batch-embed texts, upsert into the L3 collection
  embed.py query        # semantic query against the L3 collection

Protocol (line-delimited JSON over stdio):
  - Node writes ONE JSON request object to stdin, then closes stdin.
  - This script writes ONE JSON response object to stdout, then exits.
  - Diagnostic logs go to stderr (Node must not parse stderr).

Request shape (embed):
  {
    "command": "embed",
    "storePath": "<optional, defaults to ~/.databus/state/vectors/chroma>",
    "collection": "<optional, defaults to m3_summaries>",
    "items": [
      { "id": "<string>", "text": "<string>", "stamp": "<string>" },
      ...
    ]
  }

Response shape (embed):
  { "ok": true, "count": <int>, "dim": <int> }
  { "ok": false, "error": "<string>" }

Request shape (query):
  {
    "command": "query",
    "storePath": "<optional>",
    "collection": "<optional>",
    "queryText": "<string>",
    "limit": <optional int, defaults to 5>
  }

Response shape (query):
  {
    "ok": true,
    "results": [
      { "id": "<string>", "stamp": "<string>", "distance": <float>, "document": "<string>" },
      ...
    ]
  }
  { "ok": false, "error": "<string>" }

Model: ONNXMiniLM_L6_V2 (all-MiniLM-L6-v2, 384-dim, cosine).
The model is cached at ~/.cache/chroma/onnx_models/all-MiniLM-L6-v2/ (chromadb default).
"""

import sys
import os
import json
from pathlib import Path


def _get_embedding_function():
    from chromadb.utils.embedding_functions.onnx_mini_lm_l6_v2 import ONNXMiniLM_L6_V2
    return ONNXMiniLM_L6_V2()


def _get_client(store_path: str):
    import chromadb
    resolved = Path(store_path).expanduser()
    resolved.mkdir(parents=True, exist_ok=True)
    return chromadb.PersistentClient(path=str(resolved))


def _get_collection(client, name: str, embedding_function):
    return client.get_or_create_collection(
        name=name,
        embedding_function=embedding_function,
        metadata={"hnsw:space": "cosine"},
    )


def _default_store_path() -> str:
    return str(Path.home() / ".databus" / "state" / "vectors" / "chroma")


def cmd_embed(req: dict) -> dict:
    store_path = req.get("storePath") or _default_store_path()
    collection_name = req.get("collection") or "m3_summaries"
    items = req.get("items") or []

    if not isinstance(items, list) or len(items) == 0:
        return {"ok": False, "error": "items must be a non-empty array"}

    ids = []
    texts = []
    metadatas = []
    for i, item in enumerate(items):
        if not isinstance(item, dict) or "text" not in item:
            return {"ok": False, "error": f"items[{i}] missing 'text'"}
        item_id = item.get("id") or f"item-{i}"
        stamp = item.get("stamp") or ""
        ids.append(str(item_id))
        texts.append(str(item["text"]))
        metadatas.append({"stamp": str(stamp)})

    ef = _get_embedding_function()
    client = _get_client(store_path)
    collection = _get_collection(client, collection_name, ef)

    collection.upsert(ids=ids, documents=texts, metadatas=metadatas)

    sample_vector = ef([texts[0]])[0]
    dim = len(sample_vector)

    return {"ok": True, "count": len(ids), "dim": dim}


def cmd_query(req: dict) -> dict:
    store_path = req.get("storePath") or _default_store_path()
    collection_name = req.get("collection") or "m3_summaries"
    query_text = req.get("queryText")
    limit = req.get("limit") or 5

    if not isinstance(query_text, str) or len(query_text) == 0:
        return {"ok": False, "error": "queryText must be a non-empty string"}

    ef = _get_embedding_function()
    client = _get_client(store_path)
    collection = _get_collection(client, collection_name, ef)

    result = collection.query(
        query_texts=[query_text],
        n_results=int(limit),
        include=["documents", "metadatas", "distances"],
    )

    out = []
    ids_batch = result.get("ids", [[]])[0]
    docs_batch = result.get("documents", [[]])[0]
    metas_batch = result.get("metadatas", [[]])[0]
    dists_batch = result.get("distances", [[]])[0]

    for idx in range(len(ids_batch)):
        out.append({
            "id": ids_batch[idx],
            "stamp": (metas_batch[idx] or {}).get("stamp", ""),
            "distance": float(dists_batch[idx]) if idx < len(dists_batch) else None,
            "document": docs_batch[idx] if idx < len(docs_batch) else "",
        })

    return {"ok": True, "results": out}


def _send(resp: dict) -> None:
    # 显式 UTF-8：Windows 中文系统下 sys.stdout 默认 cp936（GBK），print 会把
    # 中文摘要/错误信息按 GBK 编码发到管道，Node 端按 UTF-8 toString() 得到乱码
    # （甚至半个代理项）。RAG 全文都是 CJK，这一处不对整个 Python 侧输出全废。
    sys.stdout.buffer.write((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))


def main():
    # 显式 UTF-8 读 stdin：sys.stdin 默认按系统 locale（GBK）解码，shell 管道给
    # 的是 UTF-8 字节——GBK 误读中文会产生孤立代理项（如 \udc86），chromadb 的
    # tokenizer 直接抛 "TextInputSequence must be str in upsert"。这是 RAG 对中文
    # 静默全废的根因（2026-09-16 定位）。
    raw = sys.stdin.buffer.read().decode("utf-8")
    if not raw.strip():
        _send({"ok": False, "error": "empty stdin"})
        sys.exit(0)

    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        _send({"ok": False, "error": f"invalid JSON on stdin: {e}"})
        sys.exit(0)

    command = req.get("command")
    if command == "embed":
        resp = cmd_embed(req)
    elif command == "query":
        resp = cmd_query(req)
    else:
        resp = {"ok": False, "error": f"unknown command: {command!r} (expected 'embed' or 'query')"}

    _send(resp)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[embed.py] unhandled: {type(e).__name__}: {e}\n")
        _send({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(0)
