import { useEffect, useId, useRef, useState } from 'react';
import { api, TitleSuggestionRequestError } from '../api/client';
import type { AiProvider } from '../types';
import type { Translator } from '../utils/i18n';

function providerLabel(provider: AiProvider) {
  return provider === 'openai_compatible' ? 'OpenAI compatible' : provider === 'xai_grok_oauth' ? 'Grok' : 'ChatGPT';
}

export default function SuggestedTitleField({
  value,
  promptText,
  provider,
  t,
  onChange,
  autoFocus = false,
  className = '',
}: {
  value: string;
  promptText: string;
  provider: AiProvider;
  t: Translator;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const [suggestion, setSuggestion] = useState('');
  const [suggestionProvider, setSuggestionProvider] = useState<AiProvider>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [providerAvailable, setProviderAvailable] = useState<boolean | null>(null);
  const promptRef = useRef(promptText);
  const providerRef = useRef(provider);
  const inputId = useId();

  useEffect(() => {
    promptRef.current = promptText;
    setSuggestion('');
    setSuggestionProvider(undefined);
    setError('');
  }, [promptText]);

  useEffect(() => {
    providerRef.current = provider;
    setSuggestion('');
    setSuggestionProvider(undefined);
    setError('');
    setProviderAvailable(null);
    if (provider === 'openai_compatible') { setProviderAvailable(false); return; }
    let cancelled = false;
    api.generationProviders()
      .then(providers => {
        if (cancelled) return;
        const selected = providers.find(candidate => candidate.provider === provider);
        setProviderAvailable(Boolean(selected?.configured && selected.authenticated && selected.available && selected.features.title_suggestion));
      })
      .catch(() => {
        if (!cancelled) setProviderAvailable(false);
      });
    return () => { cancelled = true; };
  }, [provider]);

  const requestSuggestion = async () => {
    const requestedPrompt = promptText.trim();
    if (provider === 'openai_compatible' || !requestedPrompt || busy || providerAvailable !== true) return;
    const requestedProvider = provider;
    setBusy(true);
    setError('');
    try {
      const result = await api.suggestTitle(requestedProvider, { prompt_text: requestedPrompt });
      if (promptRef.current.trim() === requestedPrompt && providerRef.current === requestedProvider) {
        setSuggestion(result.title);
        setSuggestionProvider(result.provider);
      }
    } catch (requestError) {
      if (promptRef.current.trim() !== requestedPrompt || providerRef.current !== requestedProvider) return;
      if (requestError instanceof TitleSuggestionRequestError) {
        if (requestError.status === 409) {
          setProviderAvailable(false);
          setError(t('titleSuggestionProviderLoginRequired').replace('${provider}', providerLabel(requestedProvider)));
        }
        else if (requestError.status === 429) setError(t('titleSuggestionRateLimited'));
        else if (requestError.status === 503) setError(t('titleSuggestionUnavailable'));
        else setError(t('titleSuggestionFailed'));
      } else {
        setError(t('titleSuggestionFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`suggested-title-field ${className}`.trim()}>
      <div className="suggested-title-label-row">
        <label htmlFor={inputId}>{t('title')}</label>
        <button type="button" className="suggest-title-button" onClick={requestSuggestion} disabled={busy || !promptText.trim() || providerAvailable !== true} title={providerAvailable === false ? (provider === 'openai_compatible' ? t('titleSuggestionUnavailable') : t('titleSuggestionProviderLoginRequired').replace('${provider}', providerLabel(provider))) : undefined}>
          {busy ? t('suggestingTitle') : t('suggestTitle')}
        </button>
      </div>
      <input id={inputId} data-modal-initial-focus={autoFocus || undefined} placeholder={t('titlePlaceholder')} value={value} onChange={event => onChange(event.currentTarget.value)} />
      {suggestion && (
        <div className="title-suggestion" role="status">
          <div className="title-suggestion-copy">
            <div className="title-suggestion-meta"><b>{t('suggestedTitle')}</b><small>{t('titleSuggestionVia').replace('${provider}', providerLabel(suggestionProvider || provider))}</small></div>
            <span>{suggestion}</span>
          </div>
          <button type="button" onClick={() => { onChange(suggestion); setSuggestion(''); }}>{t('useSuggestedTitle')}</button>
        </div>
      )}
      {(error || providerAvailable === false) && <p className="title-suggestion-error" role="alert">{error || (provider === 'openai_compatible' ? t('titleSuggestionUnavailable') : t('titleSuggestionProviderLoginRequired').replace('${provider}', providerLabel(provider)))}</p>}
    </div>
  );
}
