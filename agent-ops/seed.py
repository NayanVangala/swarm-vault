#!/usr/bin/env python3
"""Seed agent-ops/events.jsonl from the original 45-agent arena run (swarm.json).

Writes, in order:
  1 x workflow_started
  45 x agent_spawned
  45 x agent_done
  1 x workflow_done (carries the arena summary + full reportMd)
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'events.jsonl')

WORKFLOW_ID = 'arena-2026-10-12'
TITLE = 'Arena 2026-10-12 - research topic showdown'

BRIEFS = {
    'proposer': (
        "Propose a research topic for Nayan's first research project: write up the problem, "
        "approach, dataset, metrics, compute plan, deliverables, and risk/plan-B for '{label}'."
    ),
    'attacker': (
        "Cross-examine the proposal '{title}': find its fatal objection. Stress-test novelty, "
        "feasibility, scope, and whether the core claim survives contact with reality."
    ),
    'auditor': (
        "Feasibility audit of '{title}': check compute realism, dataset availability, "
        "hardware assumptions, and honest limits."
    ),
    'judge': (
        "Score the proposal '{title}' against the arena rubric (impact, novelty, feasibility, "
        "resume signal) out of 10, with a one-line justification."
    ),
    'champion': (
        "Champion '{title}' in the finals: steelman the case for it against the other finalists "
        "and name the single strongest argument in its favor."
    ),
    'synthesizer': (
        "Synthesize the whole arena: pick the winning topic, write the final report with the "
        "winner's reframed thesis, why it beat the runner-ups, honest limits, and the "
        "winner's first two weeks of work."
    ),
}

RESULTS = {
    'proposer': "Proposed '{title}'. Judge score: {score}/10.",
    'attacker': "Cross-examined a proposal for its fatal objection. Attack complete.",
    'auditor': "Feasibility-audited a proposal for compute, data, and hardware realism. Audit complete.",
    'judge': "Scored proposals against the arena rubric. Judging complete.",
    'champion': "Championed '{title}' in the finals. Finals complete.",
    'synthesizer': "Picked the winner and wrote the final arena report. Synthesis complete.",
}


def main():
    with open(os.path.join(REPO, 'swarm.json')) as f:
        d = json.load(f)
    with open(os.path.join(os.path.expanduser('~/workspace/your_files/research-topic-arena'), 'report.md')) as f:
        report_md = f.read()

    agents = d['agents']
    started = d['startedAt']
    ended = d.get('updatedAt', started)

    lines = []
    lines.append({
        'v': 1,
        'type': 'workflow_started',
        'workflow_id': WORKFLOW_ID,
        'title': TITLE,
        'kind': 'arena',
        'started_at': started,
        'source': d.get('runId'),
        'edges': d.get('edges', []),
    })

    # Spread spawns across the run so the live graph would have grown over time.
    span = max(1, ended - started)
    for i, a in enumerate(agents):
        spawned = started + int(span * i / len(agents))
        brief = BRIEFS.get(a['kind'], 'Work on {label}.').format(
            label=a.get('label', a['id']), title=a.get('title') or a.get('label', a['id']))
        lines.append({
            'v': 1,
            'type': 'agent_spawned',
            'workflow_id': WORKFLOW_ID,
            'agent_id': a['id'],
            'name': a.get('label', a['id']),
            'kind': a.get('kind', 'agent'),
            'task_brief': brief,
            'phase': a.get('phase'),
            'spawned_at': spawned,
        })

    for i, a in enumerate(agents):
        spawned = started + int(span * i / len(agents))
        elapsed_ms = a.get('elapsedMs') or 0
        done_at = spawned + elapsed_ms
        score = a.get('score')
        summary = RESULTS.get(a['kind'], 'Completed.').format(
            label=a.get('label', a['id']),
            title=a.get('title') or a.get('label', a['id']),
            score=('%.1f' % score) if score is not None else 'n/a')
        lines.append({
            'v': 1,
            'type': 'agent_done',
            'workflow_id': WORKFLOW_ID,
            'agent_id': a['id'],
            'status': a.get('status', 'completed'),
            'ended_at': done_at,
            'duration_s': round(elapsed_ms / 1000, 1),
            'result_summary': summary,
            'score': score,
        })

    winner = d.get('winner', '')
    summary = (
        "Winner: '%s'. The arena reframed it as a pre-registered measurement study "
        "(catch-rate ceiling, latency CDF, false brakes per hour) instead of a success claim. "
        "Runner-ups: Burst Lies (thermal-aware inference) and Gatekeeper Gap "
        "(quantized gatekeeper benchmark)." % winner
    )
    lines.append({
        'v': 1,
        'type': 'workflow_done',
        'workflow_id': WORKFLOW_ID,
        'ended_at': ended,
        'summary': summary,
        'winner': winner,
        'report_md': report_md,
    })

    with open(OUT, 'w') as f:
        for line in lines:
            f.write(json.dumps(line, ensure_ascii=False) + '\n')
    print('wrote %d events to %s' % (len(lines), OUT))


if __name__ == '__main__':
    main()
