const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Coordinates are relative to the centre of the photo viewport.
export class PhotoGestures {
  constructor({ onChange = () => {}, onSwipe = () => {}, onTap = () => {} } = {}) {
    Object.assign(this, { onChange, onSwipe, onTap, width: 1, height: 1,
      naturalWidth: 2400, naturalHeight: 1600, scale: 1, x: 0, y: 0, drag: 0 });
    this.points = new Map(); this.gesture = null; this.pinched = false;
  }
  get fitWidth() { return Math.min(this.width, this.height * this.naturalWidth / this.naturalHeight); }
  get fitHeight() { return this.fitWidth * this.naturalHeight / this.naturalWidth; }
  get maxScale() { return Math.min(24, Math.max(8, this.naturalWidth / this.fitWidth)); }
  emit() { this.onChange({ scale: this.scale, x: this.x, y: this.y, drag: this.drag,
    fitWidth: this.fitWidth, fitHeight: this.fitHeight }); }
  resize(width, height, naturalWidth = this.naturalWidth, naturalHeight = this.naturalHeight) {
    Object.assign(this, { width: Math.max(1, width), height: Math.max(1, height),
      naturalWidth: Math.max(1, naturalWidth), naturalHeight: Math.max(1, naturalHeight) });
    this.scale = Math.min(this.scale, this.maxScale); this.clamp(); this.emit();
  }
  clamp() {
    const boundX = Math.max(0, (this.fitWidth * this.scale - this.width) / 2);
    const boundY = Math.max(0, (this.fitHeight * this.scale - this.height) / 2);
    this.x = Math.max(-boundX, Math.min(boundX, this.x));
    this.y = Math.max(-boundY, Math.min(boundY, this.y));
  }
  reset() {
    this.points.clear(); this.gesture = null; this.pinched = false;
    this.scale = 1; this.x = this.y = this.drag = 0; this.emit();
  }
  zoomAt(nextScale, point = { x: 0, y: 0 }) {
    const next = Math.min(this.maxScale, Math.max(1, nextScale));
    this.x = point.x - (point.x - this.x) * next / this.scale;
    this.y = point.y - (point.y - this.y) * next / this.scale;
    this.scale = next; this.clamp(); this.emit();
  }
  pan(dx, dy) { this.x += dx; this.y += dy; this.clamp(); this.emit(); }
  begin(time) {
    const points = [...this.points.values()];
    if (points.length >= 2) {
      this.pinched = true; this.drag = 0;
      const centre = midpoint(points[0], points[1]);
      this.gesture = { kind: 'pinch', distance: Math.max(1, distance(points[0], points[1])),
        scale: this.scale, anchorX: (centre.x - this.x) / this.scale, anchorY: (centre.y - this.y) / this.scale };
    } else if (points.length) this.gesture = { kind: 'single', point: points[0], x: this.x, y: this.y, time };
    else this.gesture = null;
  }
  down(id, point, time) {
    if (!this.points.size) this.pinched = false;
    this.points.set(id, point); this.begin(time); this.emit();
  }
  move(id, point) {
    if (!this.points.has(id) || !this.gesture) return;
    this.points.set(id, point);
    const points = [...this.points.values()], gesture = this.gesture;
    if (gesture.kind === 'pinch' && points.length >= 2) {
      const centre = midpoint(points[0], points[1]);
      this.scale = Math.min(this.maxScale, Math.max(1, gesture.scale * distance(points[0], points[1]) / gesture.distance));
      this.x = centre.x - gesture.anchorX * this.scale;
      this.y = centre.y - gesture.anchorY * this.scale; this.clamp();
    } else if (gesture.kind === 'single') {
      const dx = points[0].x - gesture.point.x, dy = points[0].y - gesture.point.y;
      if (this.scale > 1.02) { this.x = gesture.x + dx; this.y = gesture.y + dy; this.clamp(); }
      else if (!this.pinched && Math.abs(dx) > Math.abs(dy) * 1.3) this.drag = dx * .55;
    }
    this.emit();
  }
  up(id, point, time, cancelled = false) {
    if (!this.points.has(id)) return;
    const gesture = this.gesture; this.points.delete(id);
    if (!this.points.size && gesture?.kind === 'single' && !cancelled && !this.pinched) {
      const dx = point.x - gesture.point.x, dy = point.y - gesture.point.y;
      if (this.scale <= 1.02 && Math.abs(dx) > Math.max(80, this.width * .18) && Math.abs(dx) > Math.abs(dy) * 1.5)
        this.onSwipe(dx < 0 ? 'left' : 'right');
      else if (Math.hypot(dx, dy) < 10 && time - gesture.time < 300) this.onTap(point, time);
    }
    if (!this.points.size) {
      this.drag = 0;
      if (this.scale < 1.04) { this.scale = 1; this.x = this.y = 0; }
    }
    this.begin(time); this.emit();
  }
}
