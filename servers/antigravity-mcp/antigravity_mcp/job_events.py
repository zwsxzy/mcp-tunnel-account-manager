"""MCP 2.0 job-attention subscriptions and signed, durable webhook delivery.

The authenticated single-user stdio/tunnel profile is the security principal.
Callback secrets stay in its private state directory, never in job/tool results.
"""
from __future__ import annotations

import base64
import datetime as dt
import hashlib
import hmac
import http.client
import ipaddress
import json
import os
import secrets
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

EVENT_NAME = "agent_job.attention"
DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000
MAX_ATTEMPTS = 5


def public_address(value):
    address = ipaddress.ip_address(value)
    return address.is_global and not address.is_multicast and not address.is_reserved


class CallbackError(ValueError):
    def __init__(self, reason):
        super().__init__("Callback verification or delivery failed: " + reason)
        self.reason = reason


def decode_secret(value):
    try:
        if not isinstance(value, str) or not value.startswith("whsec_"):
            raise ValueError()
        raw = base64.b64decode(value[6:], validate=True)
        if not 24 <= len(raw) <= 64:
            raise ValueError()
        return raw
    except (ValueError, TypeError):
        raise ValueError("Signing secret must be whsec_ plus 24-64 base64-decoded bytes") from None


def signed_headers(body, event_id, secret, now, subscription_id, previous_secret=None):
    timestamp = str(int(now))
    message = event_id.encode() + b"." + timestamp.encode() + b"." + body
    signatures = []
    for key in [secret] + ([previous_secret] if previous_secret else []):
        signature = base64.b64encode(hmac.new(decode_secret(key), message, hashlib.sha256).digest()).decode()
        signatures.append("v1," + signature)
    return {"Content-Type": "application/json", "webhook-id": event_id,
            "webhook-timestamp": timestamp, "webhook-signature": " ".join(signatures),
            "X-MCP-Subscription-Id": subscription_id}


def callback_parts(url):
    try:
        parts = urlsplit(url)
        if (parts.scheme != "https" or not parts.hostname or parts.username is not None
                or parts.password is not None or parts.fragment or parts.port not in (None, 443)
                or any(ord(char) < 33 or ord(char) > 126 for char in url)):
            raise ValueError()
        host = parts.hostname
        if host.lower().rstrip(".") == "localhost":
            raise ValueError()
        try:
            address = ipaddress.ip_address(host)
        except ValueError:
            address = None
        if address and not public_address(host):
            raise ValueError()
        return host, (parts.path or "/") + (("?" + parts.query) if parts.query else "")
    except (ValueError, TypeError):
        raise CallbackError("invalid_https_url") from None


class _PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Resolve once, validate *every* answer, connect that exact address, and
        # preserve the original host for certificate checking and SNI. No proxy,
        # redirect following, or second hostname lookup can bypass this check.
        try:
            addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        except OSError:
            raise CallbackError("dns_failed") from None
        if not addresses or any(not public_address(row[4][0]) for row in addresses):
            raise CallbackError("blocked_address")
        for family, socktype, proto, _, sockaddr in addresses[:1]:
            raw = socket.socket(family, socktype, proto)
            raw.settimeout(self.timeout)
            try:
                raw.connect(sockaddr)
                self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                return
            except OSError:
                raw.close()
        raise CallbackError("connection_failed")


def secure_post(url, body, headers):
    host, path = callback_parts(url)
    connection = _PinnedHTTPS(host, port=443, timeout=5, context=ssl.create_default_context())
    try:
        connection.request("POST", path, body=body, headers=headers)
        response = connection.getresponse()
        return response.status, response.read(4097)
    except CallbackError:
        raise
    except (OSError, http.client.HTTPException):
        raise CallbackError("transport_failed") from None
    finally:
        connection.close()


def event_definition():
    data_properties = {"job_id": {"type": "string"}, "status": {"type": "string"},
                       "attention": {"type": "string"}, "version": {"type": "integer"},
                       "checked_at": {"type": "number"}, "requires_gpt": {"type": "boolean"}}
    return {"name": EVENT_NAME,
            "description": "A specified dispatched job completes, fails, is cancelled, blocks, or stops making progress. Normal running checks remain local; fetch the named job before acting.",
            "delivery": ["webhook"],
            "inputSchema": {"type": "object", "properties": {"job_id": {"type": "string"}},
                            "required": ["job_id"], "additionalProperties": False},
            "payloadSchema": {"type": "object", "properties": data_properties,
                              "required": list(data_properties), "additionalProperties": False}}


class JobEventBroker:
    def __init__(self, store, known_job, *, clock=time.time, post=secure_post, owner=None):
        self.store, self.known_job, self.clock, self.post = store, known_job, clock, post
        self.owner = owner or os.environ.get("ANTIGRAVITY_EVENT_PROFILE", "private-local-profile")
        self.lock = threading.RLock()
        self.subscriptions = store.rows("subscription")
        self.outbox = store.rows("outbox")
        self.latest = store.rows("attention")
        self.stop_event = threading.Event()
        self.thread = None

    def _identity(self, params, *, require_job=True):
        if params.get("name") != EVENT_NAME:
            raise ValueError("Unsupported event")
        arguments, delivery = params.get("arguments"), params.get("delivery")
        if (not isinstance(arguments, dict) or set(arguments) != {"job_id"}
                or not isinstance(arguments["job_id"], str) or not arguments["job_id"].strip()):
            raise ValueError("Subscribe to exactly one explicit job_id")
        if require_job and not self.known_job(arguments["job_id"]):
            raise ValueError("Unknown job_id for this local profile")
        if not isinstance(delivery, dict) or delivery.get("mode") != "webhook":
            raise ValueError("Only webhook delivery is supported")
        url = delivery.get("url")
        callback_parts(url)
        canonical = json.dumps([self.owner, url, EVENT_NAME, arguments], sort_keys=True)
        return "sub_" + hashlib.sha256(canonical.encode()).hexdigest()[:32], arguments["job_id"], url

    def subscribe(self, params):
        ident, job_id, url = self._identity(params)
        if params.get("cursor") is not None:
            raise ValueError("This event does not support replay cursors")
        secret = params["delivery"].get("secret")
        decode_secret(secret)
        ttl = params.get("ttlMs")
        if ttl is None:
            ttl = DEFAULT_TTL_MS
        if type(ttl) is not int or ttl <= 0:
            raise ValueError("ttlMs must be a positive integer or null")
        now = self.clock()
        challenge = secrets.token_urlsafe(32)
        body = json.dumps({"type": "verification", "challenge": challenge}, separators=(",", ":")).encode()
        event_id = "verify_" + secrets.token_hex(16)
        headers = signed_headers(body, event_id, secret, now, ident)
        try:
            code, response = self.post(url, body, headers)
            echoed = json.loads(response).get("challenge")
            if not (200 <= code < 300 and isinstance(echoed, str)
                    and hmac.compare_digest(challenge, echoed)):
                raise ValueError()
        except CallbackError:
            raise
        except Exception:
            raise CallbackError("challenge_failed") from None
        with self.lock:
            old = self.subscriptions.get(ident)
            row = {"id": ident, "job_id": job_id, "url": url, "secret": secret,
                   "owner": self.owner, "expires_at": now + min(ttl, DEFAULT_TTL_MS) / 1000}
            if old and old["secret"] != secret:
                row.update(previous_secret=old["secret"], previous_until=now + 60)
            self.subscriptions[ident] = row
            self.store.put("subscription", ident, row)
            if job_id in self.latest:
                self._queue(row, self.latest[job_id])
        return {"id": ident, "refreshBefore": dt.datetime.fromtimestamp(row["expires_at"], dt.timezone.utc).isoformat(),
                "cursor": None, "truncated": False}

    def unsubscribe(self, params):
        ident, _, _ = self._identity(params, require_job=False)
        with self.lock:
            self.subscriptions.pop(ident, None)
            self.store.delete("subscription", ident)
            for key, row in list(self.outbox.items()):
                if row["subscription_id"] == ident and row["state"] == "pending":
                    row["state"] = "unsubscribed"
                    self.store.put("outbox", key, row)
        return {}

    def _queue(self, subscription, data):
        # Version-derived event ID survives retries and restarts; repeated tick
        # or subscribe calls do not create another delivery of the same event.
        event_id = "evt_" + hashlib.sha256(json.dumps(
            [data["job_id"], data["version"], data["attention"]]).encode()).hexdigest()[:32]
        key = subscription["id"] + "/" + event_id
        if key in self.outbox:
            return
        payload = {"eventId": event_id, "name": EVENT_NAME,
                   "timestamp": dt.datetime.fromtimestamp(data["checked_at"], dt.timezone.utc).isoformat(),
                   "data": data, "cursor": None}
        row = {"subscription_id": subscription["id"], "event_id": event_id,
               "body": json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
               "attempts": 0, "next_attempt_at": self.clock(), "state": "pending"}
        self.outbox[key] = row
        self.store.put("outbox", key, row)

    def emit(self, data):
        with self.lock:
            self.latest[data["job_id"]] = data
            self.store.put("attention", data["job_id"], data)
            for subscription in self.subscriptions.values():
                if (subscription["owner"] == self.owner and subscription["job_id"] == data["job_id"]
                        and subscription["expires_at"] > self.clock()):
                    self._queue(subscription, data)

    def deliver_due(self):
        with self.lock:
            keys = [key for key, row in self.outbox.items()
                    if row["state"] == "pending" and row["next_attempt_at"] <= self.clock()]
        for key in keys:
            if self.stop_event.is_set():
                return
            with self.lock:
                row = self.outbox[key]
                subscription = self.subscriptions.get(row["subscription_id"])
                if (row["state"] != "pending" or not subscription or subscription["owner"] != self.owner
                        or subscription["expires_at"] <= self.clock()
                        or not self.known_job(subscription["job_id"])):
                    row["state"] = "expired"
                    self.store.put("outbox", key, row)
                    continue
                now = self.clock()
                previous = subscription.get("previous_secret") if now < subscription.get("previous_until", 0) else None
                headers = signed_headers(row["body"].encode(), row["event_id"],
                                         subscription["secret"], now, subscription["id"], previous)
                row["attempts"] += 1
                # Holding this lock ensures unsubscribe cannot complete while a
                # delivery is still starting. Network operations are bounded.
                try:
                    code, _ = self.post(subscription["url"], row["body"].encode(), headers)
                except Exception:
                    code = 0  # Never expose callback URL, signing key or raw network errors.
                if 200 <= code < 300:
                    row["state"] = "delivered"  # Acknowledged receipt, not proof GPT acted.
                elif code in (410, 413) or (400 <= code < 500 and code != 429) or 300 <= code < 400:
                    row["state"] = "rejected"
                    if code == 410:
                        self.subscriptions.pop(subscription["id"], None)
                        self.store.delete("subscription", subscription["id"])
                elif row["attempts"] >= MAX_ATTEMPTS:
                    row["state"] = "exhausted"
                else:
                    row["next_attempt_at"] = now + min(300, 5 * 2 ** (row["attempts"] - 1))
                self.store.put("outbox", key, row)

    def delivery_status(self, job_id):
        with self.lock:
            ids = {row["id"] for row in self.subscriptions.values()
                   if row["owner"] == self.owner and row["job_id"] == job_id and row["expires_at"] > self.clock()}
            rows = [row for row in self.outbox.values() if row["subscription_id"] in ids]
            return {"active_subscriptions": len(ids),
                    "pending": sum(row["state"] == "pending" for row in rows),
                    "delivered": sum(row["state"] == "delivered" for row in rows),
                    "failed": sum(row["state"] in ("rejected", "exhausted") for row in rows),
                    "chat_resume_verified": False}

    def start(self):
        def loop():
            while not self.stop_event.wait(1):
                try:
                    self.deliver_due()
                except Exception:
                    continue
        self.thread = threading.Thread(target=loop, name="mcp-job-events", daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=20)
