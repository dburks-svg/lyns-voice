export interface MiniModeOptions {
  onEnter?: () => void;
  onExit?: () => void;
}

export class MiniMode {
  private active = false;
  private savedWidth = 0;
  private savedHeight = 0;
  private savedX = 0;
  private savedY = 0;
  private readonly opts: MiniModeOptions;

  constructor(opts: MiniModeOptions = {}) {
    this.opts = opts;
  }

  isActive(): boolean {
    return this.active;
  }

  async toggle(): Promise<void> {
    if (this.active) {
      await this.exit();
    } else {
      await this.enter();
    }
  }

  async enter(): Promise<void> {
    if (this.active) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const win = getCurrentWindow();
      const size = await win.innerSize();
      const pos = await win.outerPosition();
      this.savedWidth = size.width;
      this.savedHeight = size.height;
      this.savedX = pos.x;
      this.savedY = pos.y;
      await win.setMinSize(new LogicalSize(120, 120));
      await win.setSize(new LogicalSize(180, 180));
      await win.setAlwaysOnTop(true);
      document.body.classList.add('mini-mode');
      this.active = true;
      this.opts.onEnter?.();
    } catch {
      document.body.classList.add('mini-mode');
      this.active = true;
      this.opts.onEnter?.();
    }
  }

  async exit(): Promise<void> {
    if (!this.active) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const { LogicalSize, LogicalPosition } = await import('@tauri-apps/api/dpi');
      const win = getCurrentWindow();
      document.body.classList.remove('mini-mode');
      await win.setAlwaysOnTop(false);
      await win.setMinSize(new LogicalSize(420, 520));
      if (this.savedWidth > 0 && this.savedHeight > 0) {
        await win.setSize(new LogicalSize(this.savedWidth, this.savedHeight));
        await win.setPosition(new LogicalPosition(this.savedX, this.savedY));
      }
      this.active = false;
      this.opts.onExit?.();
    } catch {
      document.body.classList.remove('mini-mode');
      this.active = false;
      this.opts.onExit?.();
    }
  }
}
