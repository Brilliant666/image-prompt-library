"""Bounded, read-only observations of one durable Agent request.

Each connection starts from a new snapshot/epoch. Cursors never authorize
execution or replay provider calls; a lost epoch is recovered with another GET.
"""
import json
from uuid import uuid4

from backend.services import agent_editing_task as editing


MAX_VIEW_BYTES = 4 * 1024 * 1024
MAX_PATCH_BYTES = 512 * 1024
MAX_OPERATIONS = 512
MAX_PATH_DEPTH = 20


class ProgressLimit(ValueError):
    pass


def json_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))


def limited_view(snapshot):
    """Derive the same stable current-round projection from either public view."""
    request = snapshot['request']
    round_data = next(row for row in snapshot['conversation']['rounds'] if row['id'] == request['roundId'])
    job_ids = set(editing.all_output_ids(round_data))
    jobs = sorted((job for job in snapshot['jobs'] if job['id'] in job_ids), key=lambda job: job['id'])
    image_ids = set(editing.all_input_ids(round_data)) | {'output_' + jid for jid in job_ids}
    if round_data.get('maskImageId'):
        image_ids.add(round_data['maskImageId'])
    image_ids.update(editing.required_asset_ids(snapshot.get('editingTask')))
    task = snapshot.get('taskContext') or {}
    image_ids.update(image['assetId'] for image in ([task['target']] if task.get('target') else []) + task.get('auxiliaries', []))
    image_ids.update((job.get('metadata') or {}).get('agent', {}).get('partialImageId') for job in jobs)
    return {'revision': snapshot['revision'],
            'conversation': {key: value for key, value in snapshot['conversation'].items() if key not in {'rounds', 'messages'}},
            'request': request, 'editingTask': snapshot.get('editingTask'), 'round': round_data,
            **({key: snapshot[key] for key in ('taskContext', 'contextMode') if key in snapshot}),
            'messages': [message for message in snapshot['conversation']['messages'] if message['roundId'] == request['roundId']],
            'images': sorted((image for image in snapshot['images'] if image['id'] in image_ids), key=lambda image: image['id']),
            'jobs': jobs}


def diff_view(previous, current):
    """Use UTF-16 offsets because the browser applies append to JS strings."""
    operations = []

    def visit(before, after, path):
        if before == after:
            return
        if len(path) > MAX_PATH_DEPTH or len(operations) >= MAX_OPERATIONS:
            raise ProgressLimit('patch_limit')
        if isinstance(before, str) and isinstance(after, str) and after.startswith(before):
            operations.append({'op': 'append', 'path': path, 'offset': len(before.encode('utf-16-le', 'surrogatepass')) // 2,
                               'value': after[len(before):]})
        elif isinstance(before, dict) and isinstance(after, dict) and before.keys() == after.keys():
            for key in after:
                visit(before[key], after[key], [*path, key])
        elif isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
            for index, item in enumerate(after):
                visit(before[index], item, [*path, index])
        else:
            operations.append({'op': 'replace', 'path': path, 'value': after})

    visit(previous, current, [])
    return operations


class ProgressSession:
    def __init__(self, snapshot):
        request = snapshot['request']
        self.identity = {'version': 1, 'epoch': uuid4().hex, 'requestId': request['id'],
                         'conversationId': request['conversationId'], 'roundId': request['roundId']}
        self.sequence = 0
        view = limited_view(snapshot)
        self.view = view if json_bytes(view) <= MAX_VIEW_BYTES else None

    def initial(self, snapshot):
        stream = {**self.identity, 'sequence': self.sequence}
        if self.view is not None:
            stream['view'] = self.view
        return {**snapshot, 'stream': stream}

    def patch(self, view):
        if self.view is None or json_bytes(view) > MAX_VIEW_BYTES:
            raise ProgressLimit('view_limit')
        if (view['request']['id'], view['conversation']['id'], view['round']['id']) != (
                self.identity['requestId'], self.identity['conversationId'], self.identity['roundId']):
            raise ValueError('Observation identity changed')
        # Physical removal needs a full snapshot; upserts alone cannot remove
        # stale cards. Normal deleted results remain explicit removed images.
        for key in ('jobs',):
            if {item['id'] for item in self.view[key]} - {item['id'] for item in view[key]}:
                raise ValueError('Observation entities removed')
        operations = diff_view(self.view, view)
        if not operations:
            return None
        payload = {**self.identity, 'sequence': self.sequence + 1, 'baseSequence': self.sequence, 'operations': operations}
        if json_bytes(payload) > MAX_PATCH_BYTES:
            raise ProgressLimit('patch_limit')
        self.sequence += 1
        self.view = view
        return payload
