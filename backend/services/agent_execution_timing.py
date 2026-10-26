"""Bounded Agent execution measurements and durable-result summaries.

Monotonic clock origins stay in memory; only measured differences are stored.
HTTP headers/first-event durations are milestones, not additive phases.
"""
from time import monotonic

from backend.services.agent_diagnostics import duration_ms

TIMINGS = ('preparationMs', 'modelHeadersMs', 'modelFirstEventMs', 'modelResponseMs', 'toolsMs', 'resultProcessingMs')
PHASES = frozenset({'preparing', 'waiting_model', 'receiving_model', 'waiting_jobs', 'generating_images',
                    'processing_results', 'completed', 'failed', 'stopped', 'unknown'})


def elapsed(start):
    return duration_ms((monotonic() - start) * 1000)


def empty_execution(preparation=None):
    return {'version': 1, 'phase': 'preparing', 'timings': {key: preparation if key == 'preparationMs' else None for key in TIMINGS},
            'modelSteps': []}


class ModelTiming:
    def __init__(self, repo, request_id, step):
        self.repo, self.request_id, self.step = repo, request_id, step
        self.preparation_started = monotonic()
        self.http_started = None
        self.first_seen = self.receiving = self.finished = False
        repo.record_execution(request_id, phase='preparing', step=step)

    def start_http(self):
        self.repo.record_execution(self.request_id, phase='waiting_model', step=self.step,
                                   preparationMs=elapsed(self.preparation_started))
        self.http_started = monotonic()

    def headers(self):
        self.repo.record_execution(self.request_id, step=self.step, headersMs=elapsed(self.http_started))

    def event(self, *, receiving=False):
        fields = {}
        if not self.first_seen:
            fields['firstEventMs'] = elapsed(self.http_started)
            self.first_seen = True
        phase = None
        if receiving and not self.receiving:
            phase, self.receiving = 'receiving_model', True
        if fields or phase:
            self.repo.record_execution(self.request_id, phase=phase, step=self.step, **fields)

    def finish(self, completed=False):
        if self.finished:
            return
        self.finished = True
        fields = {'responseMs': elapsed(self.http_started)} if self.http_started is not None else {
            'preparationMs': elapsed(self.preparation_started)}
        self.repo.record_execution(self.request_id, step=self.step, state='completed' if completed else 'interrupted',
                                   phase='processing_results' if completed else None, **fields)


def apply_measurement(value, *, phase=None, step=None, state=None, add=False, **durations):
    if phase in PHASES:
        value['phase'] = phase
    if step is None:
        for key, raw in durations.items():
            measured = duration_ms(raw)
            if key in TIMINGS and measured is not None:
                old = value['timings'].get(key)
                value['timings'][key] = duration_ms((old or 0) + measured) if add else measured
        return
    if type(step) is not int or not 1 <= step <= 50:
        return
    target = next((item for item in value['modelSteps'] if item['step'] == step), None)
    if target is None:
        target = {'step': step, 'state': 'running', 'preparationMs': None, 'headersMs': None, 'firstEventMs': None, 'responseMs': None}
        value['modelSteps'].append(target)
    if state in {'running', 'completed', 'interrupted'}:
        target['state'] = state
    for key in ('preparationMs', 'headersMs', 'firstEventMs', 'responseMs'):
        measured = duration_ms(durations.get(key))
        if measured is not None:
            if key == 'preparationMs':
                previous = target.get(key) or 0
                value['timings']['preparationMs'] = duration_ms((value['timings'].get('preparationMs') or 0) - previous + measured)
            target[key] = measured
    for total, field in (('modelHeadersMs', 'headersMs'), ('modelFirstEventMs', 'firstEventMs'), ('modelResponseMs', 'responseMs')):
        measurements = [item[field] for item in value['modelSteps']]
        value['timings'][total] = duration_ms(sum(measurements)) if measurements and all(v is not None for v in measurements) else None


def image_failure_message(jobs):
    succeeded = sum(job.status in {'succeeded', 'accepted'} for job in jobs)
    return (f'部分图片未完成；已保留 {succeeded} 张成功图片，需要明确发起新请求。' if succeeded else
            '本次未生成图片；请查看失败原因，再明确决定是否重试。')


def result_summary(round_data, request, jobs, text_completed=False):
    ids = list(dict.fromkeys(round_data.get('outputTaskIds', [])))
    present = [jobs[jid] for jid in ids if jid in jobs]
    count = lambda statuses: sum(job['status'] in statuses for job in present)
    state = request.get('state') if request else None
    active = state in {'queued', 'running', 'waiting_for_jobs', 'stop_requested'}
    unknown = bool(request and not active and (state == 'unknown' or request.get('upstream_outcome') == 'unknown'))
    unknown |= any((job.get('metadata') or {}).get('failure', {}).get('outcomeUnknown') is True for job in present)
    unknown |= len(ids) != len(present) or any(job['status'] == 'unknown' for job in present)
    model_completed = any(item.get('state') == 'completed' for item in (round_data.get('execution') or {}).get('modelSteps', []))
    summary = {'requestState': state, 'textCompleted': bool(text_completed or model_completed or state == 'completed'),
               'imageJobsCreated': len(ids), 'imageJobsQueued': count({'queued'}), 'imageJobsRunning': count({'running'}),
               'imageJobsSucceeded': count({'succeeded', 'accepted'}), 'imageJobsFailed': count({'failed'}),
               'imageJobsCancelled': count({'cancelled'}), 'imageJobsAccepted': count({'accepted'}),
               'imageJobsDiscarded': count({'discarded'}), 'imageJobsMissing': len(ids) - len(present),
               'outcomeUnknown': unknown, 'maxImageJobs': (request.get('body') or {}).get('authorization', {}).get('maxImageJobs') if request else None}
    if unknown and state not in {'queued', 'running', 'waiting_for_jobs', 'stop_requested'}:
        outcome = 'unknown'
    elif state in {'stopped', 'stop_requested'}:
        outcome = 'stopped'
    elif summary['imageJobsRunning']:
        outcome = 'working'
    elif summary['imageJobsQueued']:
        outcome = 'waiting'
    elif summary['imageJobsSucceeded']:
        outcome = 'images_succeeded' if summary['imageJobsSucceeded'] == len(ids) else 'images_partial'
    elif summary['imageJobsFailed']:
        outcome = 'images_failed'
    elif summary['imageJobsCancelled']:
        outcome = 'stopped'
    elif summary['imageJobsDiscarded'] or summary['imageJobsMissing']:
        outcome = 'cleared'
    elif state == 'queued':
        outcome = 'waiting'
    elif state in {'running', 'waiting_for_jobs'}:
        outcome = 'working'
    else:
        outcome = 'text_completed' if state == 'completed' else 'failed'
    summary['outcome'] = outcome
    return summary
