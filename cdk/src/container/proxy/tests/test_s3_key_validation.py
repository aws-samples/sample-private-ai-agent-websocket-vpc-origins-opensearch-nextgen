"""Security tests: S3 key validation in fetch_text_from_s3.

Validates:
  * Valid keys matching generated format are accepted.
  * Path traversal attempts are rejected.
  * Arbitrary key patterns are rejected.
"""

from __future__ import annotations

import os
import sys

import pytest

_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROXY_DIR = os.path.dirname(_TESTS_DIR)
if _PROXY_DIR not in sys.path:
    sys.path.insert(0, _PROXY_DIR)

from unittest.mock import patch

from config import Settings


@pytest.fixture
def settings_with_uploads():
    return Settings(upload_bucket="test-bucket")


def test_rejects_path_traversal(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "extracted/../../etc/passwd", settings=settings_with_uploads
    )
    assert result == ""


def test_rejects_arbitrary_prefix(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "other/upload-abcd1234abcd1234abcd1234abcd1234.txt",
        settings=settings_with_uploads,
    )
    assert result == ""


def test_rejects_missing_upload_prefix(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "extracted/notupload-abcd1234abcd1234abcd1234abcd1234.txt",
        settings=settings_with_uploads,
    )
    assert result == ""


def test_rejects_wrong_extension(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "extracted/upload-abcd1234abcd1234abcd1234abcd1234.json",
        settings=settings_with_uploads,
    )
    assert result == ""


def test_rejects_short_hex(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "extracted/upload-abcd1234.txt", settings=settings_with_uploads
    )
    assert result == ""


def test_rejects_uppercase_hex(settings_with_uploads):
    import documents
    result = documents.fetch_text_from_s3(
        "extracted/upload-ABCD1234ABCD1234ABCD1234ABCD1234.txt",
        settings=settings_with_uploads,
    )
    assert result == ""


def test_accepts_valid_key_format(settings_with_uploads):
    """A valid key format passes validation (S3 call will still fail without mocking)."""
    import documents

    valid_key = "extracted/upload-abcd1234abcd1234abcd1234abcd1234.txt"
    # Patch boto3 at the builtins level since it's lazily imported inside the function
    import unittest.mock as mock
    mock_body = mock.MagicMock()
    mock_body.read.return_value = b"test content"
    mock_client = mock.MagicMock()
    mock_client.get_object.return_value = {"Body": mock_body}
    mock_boto3 = mock.MagicMock()
    mock_boto3.client.return_value = mock_client

    with patch.dict("sys.modules", {"boto3": mock_boto3}):
        import importlib
        importlib.reload(documents)
        result = documents.fetch_text_from_s3(valid_key, settings=settings_with_uploads)
        assert result == "test content"
