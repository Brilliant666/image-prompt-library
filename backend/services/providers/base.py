"""Small provider boundaries. Task ownership and recovery remain in the application."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Mapping, NamedTuple, Protocol

ImageInput = tuple[str, bytes, str]
PartialCallback = Callable[[bytes, dict[str, Any]], None]


class ImageResult(NamedTuple):
    """One validated final, compatible with the existing result tuple.

    No database task state is implied by returning this value. The shared job
    runner must durably preserve these bytes before optional observation writes.
    """
    data: bytes
    filename: str
    metadata: dict[str, Any]


@dataclass(frozen=True)
class ModelCapabilities:
    input_modalities: tuple[str, ...] = ()
    output_modalities: tuple[str, ...] = ()
    modes: tuple[str, ...] = ()
    max_input_images: int | None = None
    param_keys: tuple[str, ...] = ()
    image_generation: bool | None = None
    source: str = 'unknown'


class ImageProvider(Protocol):
    def generate(self, prompt: str, parameters: dict[str, Any],
                 input_images: list[ImageInput] | None = None,
                 on_partial: PartialCallback | None = None) -> ImageResult | tuple[bytes, str, dict[str, Any]]: ...


class GenerationExecutor(Protocol):
    def run_job(self, library_path: Any, job_id: str) -> Any: ...


class ModelCatalog(Protocol):
    def discover_models(self, normalized_root: str, api_key: str, http_client: Any = None,
                        *, network_settings: Mapping[str, Any] | None = None) -> list[dict[str, Any]]: ...


class TextProvider(Protocol):
    def complete(self, client: Any, url: str, **request_options: Any) -> Any:
        """Return a response context manager, not flattened assistant text."""
        ...


class ParamMapper(Protocol):
    def normalize(self, parameters: Mapping[str, Any], default_model: str = '') -> dict[str, Any]: ...


@dataclass(frozen=True)
class ProviderDescriptor:
    id: str
    display_name: str
    auth_mode: str
    executor_factory: Callable[..., GenerationExecutor] | None = None
    image_factory: Callable[..., ImageProvider] | None = None
    catalog_factory: Callable[[], ModelCatalog] | None = None
    text_factory: Callable[[], TextProvider] | None = None
    mapper_factory: Callable[[], ParamMapper] | None = None
    legacy_executor: bool = False

    @property
    def automated(self) -> bool:
        return self.executor_factory is not None
