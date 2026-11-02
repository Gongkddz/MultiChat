import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi.testclient import TestClient

import server


class FakeCompletions:
    def __init__(self, chunks=None, error=None):
        self.chunks = chunks or []
        self.error = error
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        if self.error:
            raise self.error
        return iter(self.chunks)


class FakeClient:
    def __init__(self, chunks=None, error=None):
        self.chat = SimpleNamespace(
            completions=FakeCompletions(chunks=chunks, error=error)
        )


def sse_payloads(response):
    return [
        json.loads(line[6:])
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


class StreamingTests(unittest.TestCase):
    def setUp(self):
        server.api_keys["nvidia"] = "test-key"
        server.current_provider = "nvidia"

    def test_provider_error_is_forwarded_to_client(self):
        with patch.object(
            server,
            "get_client",
            return_value=FakeClient(error=RuntimeError("model is deprecated")),
        ):
            response = TestClient(server.app).post(
                "/api/chat",
                json={"model": "removed/model", "messages": [{"role": "user", "content": "hi"}]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sse_payloads(response), [
            {"error": "NVIDIA API 请求失败: model is deprecated"}
        ])

    def test_successful_stream_has_content_and_terminal_event(self):
        chunks = [
            SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        finish_reason=None,
                        delta=SimpleNamespace(content="OK", reasoning_content=None),
                    )
                ]
            ),
            SimpleNamespace(
                choices=[SimpleNamespace(finish_reason="stop", delta=None)]
            ),
        ]
        with patch.object(server, "get_client", return_value=FakeClient(chunks=chunks)):
            response = TestClient(server.app).post(
                "/api/chat",
                json={"model": "working/model", "messages": [{"role": "user", "content": "hi"}]},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(sse_payloads(response), [
            {"content": "OK"},
            {"done": True, "finish_reason": "stop"},
        ])

    def test_deepseek_v4_uses_nvidia_recommended_parameters(self):
        fake_client = FakeClient(chunks=[])
        with patch.object(server, "get_client", return_value=fake_client):
            response = TestClient(server.app).post(
                "/api/chat",
                json={
                    "model": "deepseek-ai/deepseek-v4-flash-0731",
                    "messages": [{"role": "user", "content": "hi"}],
                    "top_p": 1.0,
                },
            )

        self.assertEqual(response.status_code, 200)
        kwargs = fake_client.chat.completions.last_kwargs
        self.assertEqual(kwargs["top_p"], 0.95)
        self.assertEqual(
            kwargs["extra_body"]["chat_template_kwargs"]["reasoning_effort"],
            "high",
        )

    def test_kimi_uses_low_effort_without_top_p(self):
        fake_client = FakeClient(chunks=[])
        with patch.object(server, "get_client", return_value=fake_client):
            response = TestClient(server.app).post(
                "/api/chat",
                json={
                    "model": "moonshotai/kimi-k3",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        self.assertEqual(response.status_code, 200)
        kwargs = fake_client.chat.completions.last_kwargs
        self.assertEqual(kwargs["reasoning_effort"], "low")
        self.assertNotIn("top_p", kwargs)

    def test_stale_serverless_model_is_hidden(self):
        self.assertEqual(
            server.visible_models([
                "nvidia/nemotron-4-340b-instruct",
                "nvidia/nemotron-3.5-lightning-30b-a3b",
            ]),
            ["nvidia/nemotron-3.5-lightning-30b-a3b"],
        )

    def test_eof_without_finish_marker_is_an_error_and_keeps_partial_text(self):
        chunks = [SimpleNamespace(choices=[SimpleNamespace(
            finish_reason=None, delta=SimpleNamespace(content="partial"))])]
        with patch.object(server, "get_client", return_value=FakeClient(chunks=chunks)):
            events = sse_payloads(TestClient(server.app).post(
                "/api/chat", json={"model": "test", "messages": []}))
        self.assertEqual(events[0], {"content": "partial"})
        self.assertIn("error", events[-1])
        self.assertFalse(any(e.get("done") for e in events))

    def test_usage_only_chunk_after_finish_is_forwarded(self):
        for usage in [
            SimpleNamespace(prompt_tokens=100, completion_tokens=30, total_tokens=130,
                            prompt_cache_hit_tokens=80),
            SimpleNamespace(prompt_tokens=100, completion_tokens=30, total_tokens=130,
                            prompt_tokens_details={"cached_tokens": 80}),
        ]:
            with self.subTest(usage=usage):
                chunks = [SimpleNamespace(choices=[SimpleNamespace(finish_reason="length", delta=None)]),
                          SimpleNamespace(choices=[], usage=usage)]
                fake = FakeClient(chunks=chunks)
                with patch.object(server, "get_client", return_value=fake):
                    events = sse_payloads(TestClient(server.app).post(
                        "/api/chat", json={"model": "test", "messages": []}))
                self.assertEqual(events[0]["usage"], {
                    "prompt_tokens": 100, "completion_tokens": 30,
                    "total_tokens": 130, "cached_tokens": 80})
                self.assertEqual(events[-1], {"done": True, "finish_reason": "length"})
                self.assertTrue(fake.chat.completions.last_kwargs["stream_options"]["include_usage"])

    def test_provider_rejecting_usage_option_can_still_stream(self):
        calls = []
        class UnsupportedOption(Exception):
            status_code = 400
        fake = FakeClient()
        def create(**kwargs):
            calls.append(kwargs)
            if "stream_options" in kwargs:
                raise UnsupportedOption("stream_options is not supported")
            return iter([SimpleNamespace(choices=[SimpleNamespace(finish_reason="stop", delta=None)])])
        fake.chat.completions.create = create
        with patch.object(server, "get_client", return_value=fake):
            events = sse_payloads(TestClient(server.app).post(
                "/api/chat", json={"model": "test", "messages": []}))
        self.assertEqual(len(calls), 2)
        self.assertNotIn("stream_options", calls[-1])
        self.assertEqual(events[-1], {"done": True, "finish_reason": "stop"})

    def test_deepseek_chat_uses_official_provider_without_nvidia_only_seed(self):
        fake_client = FakeClient(chunks=[])
        server.api_keys["deepseek"] = "test-deepseek-key"
        with patch.object(server, "get_client", return_value=fake_client):
            response = TestClient(server.app).post(
                "/api/chat",
                json={
                    "provider": "deepseek",
                    "model": "deepseek-v4-flash",
                    "messages": [{"role": "user", "content": "hi"}],
                },
            )

        self.assertEqual(response.status_code, 200)
        kwargs = fake_client.chat.completions.last_kwargs
        self.assertEqual(kwargs["model"], "deepseek-v4-flash")
        self.assertNotIn("seed", kwargs)

    def test_switch_provider_requires_its_own_key(self):
        server.api_keys.pop("deepseek", None)
        response = TestClient(server.app).post(
            "/api/provider", json={"provider": "deepseek"}
        )
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
