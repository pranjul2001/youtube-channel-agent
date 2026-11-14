// Live progress for the dashboard: what is being made right now and how far along it is.
// One in-memory task per kind of work ("topics", "video", "publish"). Each task has ordered
// steps with a weight; overall percent = finished steps + the current step's fraction.
// Progress is display-only: nothing reads it to make decisions.
const KEEP_FINISHED_MS = 15 * 60 * 1000;

const PLANS = {
  topics: [['trends', 'Collecting trends', 2], ['choosing', 'Choosing topics', 5], ['checking', 'Checking articles', 3]],
  video: [['topic', 'Topic', 1], ['script', 'Research & script', 14], ['voice', 'Voice', 25], ['visuals', 'Visuals', 45], ['finishing', 'Subtitles & thumbnail', 15]],
  publish: [['upload', 'Uploading video', 85], ['thumbnail', 'Thumbnail', 5], ['captions', 'Captions', 10]]
};

class ProgressTracker {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.tasks = new Map();
  }

  start(id, title, detail = '') {
    const plan = PLANS[id];
    if (!plan) return null;
    const task = { id, title: String(title || '').slice(0, 140), status: 'running', step: plan[0][0], fraction: 0, detail, startedAt: this.now(), updatedAt: this.now(), finishedAt: null };
    this.tasks.set(id, task);
    return task;
  }

  // Start only when nothing of this kind is running (deep pipeline code calls this).
  ensure(id, title) {
    const current = this.tasks.get(id);
    return current && current.status === 'running' ? current : this.start(id, title);
  }

  update(id, { step, fraction, detail, title } = {}) {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    const plan = PLANS[id];
    if (step && plan.some(([key]) => key === step)) {
      const moved = step !== task.step;
      // Never move backwards (a late event from an earlier step must not rewind the bar).
      if (plan.findIndex(([key]) => key === step) >= plan.findIndex(([key]) => key === task.step)) {
        task.step = step;
        if (moved) { task.fraction = 0; task.detail = ''; }
      }
    }
    if (Number.isFinite(fraction)) task.fraction = Math.max(0, Math.min(1, fraction));
    if (detail !== undefined) task.detail = String(detail).slice(0, 160);
    if (title) task.title = String(title).slice(0, 140);
    task.updatedAt = this.now();
  }

  finish(id, detail = 'Done') {
    const task = this.tasks.get(id);
    if (!task) return;
    Object.assign(task, { status: 'done', fraction: 1, detail: String(detail).slice(0, 160), finishedAt: this.now(), updatedAt: this.now() });
  }

  fail(id, detail = 'Failed') {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'running') return;
    Object.assign(task, { status: 'failed', detail: String(detail).slice(0, 200), finishedAt: this.now(), updatedAt: this.now() });
  }

  list() {
    const out = [];
    for (const [id, task] of this.tasks) {
      if (task.finishedAt && this.now() - task.finishedAt > KEEP_FINISHED_MS) { this.tasks.delete(id); continue; }
      const plan = PLANS[id];
      const total = plan.reduce((sum, [, , weight]) => sum + weight, 0);
      const index = plan.findIndex(([key]) => key === task.step);
      const before = plan.slice(0, index).reduce((sum, [, , weight]) => sum + weight, 0);
      const percent = task.status === 'done' ? 100 : Math.round(((before + plan[index][2] * task.fraction) / total) * 100);
      out.push({
        id, title: task.title, status: task.status, detail: task.detail, percent,
        steps: plan.map(([key, label], i) => ({ key, label, state: task.status === 'done' || i < index ? 'done' : i === index ? (task.status === 'failed' ? 'failed' : 'current') : 'todo' })),
        startedAt: new Date(task.startedAt).toISOString(), updatedAt: new Date(task.updatedAt).toISOString(),
        elapsedSeconds: Math.round(((task.finishedAt || this.now()) - task.startedAt) / 1000)
      });
    }
    return out.sort((a, b) => (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1));
  }
}

const progress = new ProgressTracker();
module.exports = { ProgressTracker, progress, PLANS };
