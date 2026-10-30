from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class AgentModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AgentConfig(AgentModel):
    apiConfigMode: Literal["off", "native", "hybrid"] = "hybrid"
    textProfileId: str | None = None
    imageProfileId: str | None = None
    textModel: str = Field(default="", max_length=200)
    imageModel: str = Field(default="", max_length=200)
    reasoningEffort: Literal["none", "minimal", "low", "medium", "high", "xhigh", "max"] | None = None
    stream: bool = True
    partialImages: int = Field(default=1, ge=0, le=3)
    maxToolRounds: int = Field(default=15, ge=1, le=50)
    maxImageJobs: int = Field(default=4, ge=1, le=20)
    webSearch: bool = False
    mathFormattingPrompt: bool = True
    professionalPromptWorkflows: bool = True
    experimentalImageDeduplication: bool = False


class AgentConfigSave(AgentModel):
    expectedRevision: int = Field(ge=0)
    config: AgentConfig


class AgentConversationCreate(AgentModel):
    id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    title: str = Field(default="新对话", min_length=1, max_length=200)


class AgentConversationPatch(AgentModel):
    expectedRevision: int = Field(ge=0)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    activeRoundId: str | None = None


class AgentRef(AgentModel):
    kind: Literal["library", "job", "upload"]
    imageId: str | None = None
    jobId: str | None = None
    uploadId: str | None = None


class AgentEditingAuxiliary(AgentModel):
    ref: AgentRef
    role: Literal['lighting', 'style', 'subject', 'composition', 'other'] = 'other'


class AgentEditingTask(AgentModel):
    target: AgentRef | None = None
    auxiliaries: list[AgentEditingAuxiliary] = Field(default_factory=list, max_length=3)
    requirements: str = Field(default='', max_length=4000)
    constraints: list[Annotated[str, Field(max_length=500)]] = Field(default_factory=list, max_length=12)
    workflow: Literal['auto', 'image-prompt-reverse', 'gpt-image'] = 'auto'


class AgentEditingTaskPatch(AgentModel):
    expectedRevision: int = Field(ge=0)
    branchRoundId: str | None = None
    task: AgentEditingTask | None


class AgentTaskOperation(AgentModel):
    op: Literal['new_task', 'start_task', 'reconcile_text_source', 'set_task_type', 'set_target', 'set_auxiliaries', 'add_constraint',
                'update_constraint', 'revoke_constraint', 'set_prompt', 'select_prompt',
                'restore_prompt', 'restore_working_prompt', 'set_unresolved', 'set_history_dependencies']
    id: str | None = Field(default=None, max_length=100)
    roundId: str | None = Field(default=None, max_length=100)
    text: str | None = Field(default=None, max_length=100_000)
    kind: Literal['candidate', 'selected'] | None = None
    taskType: Literal['chat', 'image_edit', 'image_generation', 'prompt', 'analysis', 'reverse', 'prompt_optimization'] | None = None
    ref: AgentRef | None = None
    auxiliaries: list[AgentEditingAuxiliary] | None = Field(default=None, max_length=3)
    items: list[Annotated[str, Field(max_length=1000)]] | None = Field(default=None, max_length=24)
    source: dict | None = None
    sourceQuote: str | None = Field(default=None, min_length=1, max_length=100_000)
    dependencies: list[dict] | None = Field(default=None, max_length=128)


class AgentTaskContextPatch(AgentModel):
    expectedRevision: int = Field(ge=0)
    branchRoundId: str | None = None
    taskRevision: int | None = Field(default=None, ge=0)
    operations: list[AgentTaskOperation] = Field(min_length=1, max_length=24)


class AgentMask(AgentModel):
    targetRefIndex: int = Field(ge=0)
    uploadId: str


class AgentParams(AgentModel):
    size: str = "1024x1024"
    quality: str = "auto"
    output_format: Literal["png", "jpeg", "webp"] = "png"
    output_compression: int | None = Field(default=None, ge=0, le=100)
    moderation: str | None = None
    background: str | None = None


class AgentAuthorization(AgentModel):
    scope: Literal["this_request"]
    allowImageGeneration: bool
    allowWebSearch: bool = False
    maxToolRounds: int = Field(ge=1, le=50)
    maxImageJobs: int = Field(ge=0, le=20)


class AgentImageConfig(AgentModel):
    profileId: str | None = Field(default=None, min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    model: str = Field(max_length=200)


class AgentRoundCreate(AgentModel):
    requestId: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")
    expectedRevision: int = Field(ge=0)
    parentRoundId: str | None = None
    origin: Literal["send", "edit", "regenerate"] = "send"
    derivedFromRoundId: str | None = None
    prompt: str = Field(min_length=1, max_length=100_000)
    refs: list[AgentRef] = Field(default_factory=list, max_length=4)
    mask: AgentMask | None = None
    configRevision: int = Field(ge=0)
    activeProfileId: str | None = None
    imageConfig: AgentImageConfig | None = None
    imageCount: Literal[1, 3, 5, 10] = 1
    params: AgentParams = Field(default_factory=AgentParams)
    authorization: AgentAuthorization
    contextScope: Literal['task', 'branch', 'selected'] = 'task'
    historyRoundIds: list[Annotated[str, Field(max_length=100)]] = Field(default_factory=list, max_length=128)
    taskRevision: int | None = Field(default=None, ge=0)


class AgentResume(AgentModel):
    resumeId: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_-]+$")


class AgentPromptExecutionCreate(AgentModel):
    requestId: str = Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9_-]+$')
    expectedRevision: int = Field(ge=0)
    branchRoundId: str | None = None
    taskId: str = Field(min_length=1, max_length=100)
    taskRevision: int = Field(ge=0)
    promptVersionId: str = Field(min_length=1, max_length=100)
    configRevision: int = Field(ge=0)
    imageConfig: AgentImageConfig | None = None
    params: AgentParams
    imageCount: Literal[1, 3, 5, 10] = 1
    confirmed: Literal[True]
