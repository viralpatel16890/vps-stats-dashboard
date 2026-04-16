import { DatePipe, DecimalPipe, NgClass, NgFor, NgIf, PercentPipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { finalize } from 'rxjs';

interface HealthStatus {
  name: string;
  status: 'up' | 'down' | 'not-detected';
  source: string;
}

interface TreeNode {
  path: string;
  sizeBytes: number;
  ratio: number;
}

interface MetricsResponse {
  timestamp: string;
  cpu: {
    usagePercent: number;
  };
  memory: {
    usagePercent: number;
    totalBytes: number;
    usedBytes: number;
  };
  disk: {
    mount: string;
    usagePercent: number;
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
  };
  docker: {
    running: boolean;
    runningCount: number;
    stoppedCount: number;
    totalCount: number;
    containers: Array<{
      name: string;
      state: string;
      status: string;
      image: string;
      lastSeenAt: string;
    }>;
  };
  database: {
    overall: 'up' | 'down' | 'not-detected';
    engines: HealthStatus[];
  };
  storageTree: TreeNode[];
  websites: Array<{
    host: string;
    status: 'up' | 'down';
    httpCode: number;
    responseMs: number;
    checkedAt: string;
  }>;
}

interface TreemapRect {
  node: TreeNode;
  top: number;
  left: number;
  width: number;
  height: number;
}

@Component({
  selector: 'app-root',
  imports: [
    NgFor,
    NgIf,
    NgClass,
    DecimalPipe,
    PercentPipe,
    DatePipe,
    TitleCasePipe,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatProgressBarModule,
    MatProgressSpinnerModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private eventSource: EventSource | null = null;

  protected readonly title = signal('Stats Control Deck');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly metrics = signal<MetricsResponse | null>(null);
  protected readonly lastUpdated = signal<Date | null>(null);
  protected readonly isDarkMode = signal(false);
  protected readonly selectedNode = signal<TreeNode | null>(null);

  protected readonly treemapLayout = computed(() => {
    const data = this.metrics();
    if (!data || !data.storageTree.length) return [];

    const nodes = data.storageTree;
    const rects: TreemapRect[] = [];
    
    // Simple tiling algorithm (Binary Split)
    const compute = (
      items: TreeNode[],
      x: number,
      y: number,
      width: number,
      height: number
    ) => {
      if (items.length === 0) return;
      if (items.length === 1) {
        rects.push({ node: items[0], top: y, left: x, width, height });
        return;
      }

      const totalRatio = items.reduce((sum, item) => sum + item.ratio, 0);
      let halfRatio = 0;
      let mid = 0;
      for (let i = 0; i < items.length - 1; i++) {
        halfRatio += items[i].ratio;
        mid = i + 1;
        if (halfRatio >= totalRatio / 2) break;
      }

      const leftItems = items.slice(0, mid);
      const rightItems = items.slice(mid);
      const ratio = halfRatio / totalRatio;

      if (width > height) {
        // Horizontal split
        const leftWidth = width * ratio;
        compute(leftItems, x, y, leftWidth, height);
        compute(rightItems, x + leftWidth, y, width - leftWidth, height);
      } else {
        // Vertical split
        const leftHeight = height * ratio;
        compute(leftItems, x, y, width, leftHeight);
        compute(rightItems, x, y + leftHeight, width, height - leftHeight);
      }
    };

    compute(nodes, 0, 0, 100, 100);
    return rects;
  });

  protected readonly healthStatus = computed(() => {
    const data = this.metrics();
    if (!data) {
      return { color: 'gray', text: 'Loading' };
    }

    const criticalCount =
      (data.cpu.usagePercent >= 85 ? 1 : 0) +
      (data.memory.usagePercent >= 85 ? 1 : 0) +
      (data.disk.usagePercent >= 85 ? 1 : 0) +
      (data.docker.stoppedCount > 0 ? 1 : 0) +
      (data.database.overall === 'down' ? 1 : 0) +
      (data.websites.filter((w) => w.status === 'down').length > 0 ? 1 : 0);

    if (criticalCount >= 3) {
      return { color: '#b33d3d', text: '● Critical' };
    }
    if (criticalCount >= 1) {
      return { color: '#a26d1f', text: '● Caution' };
    }
    return { color: '#1f7a5a', text: '✓ Healthy' };
  });

  ngOnInit(): void {
    this.initializeTheme();
    this.refresh();
    this.setupSSE();
  }

  ngOnDestroy(): void {
    this.closeSSE();
  }

  private setupSSE(): void {
    this.closeSSE();
    this.eventSource = new EventSource('/api/events');

    this.eventSource.onmessage = (event) => {
      try {
        const data: MetricsResponse = JSON.parse(event.data);
        this.metrics.set(data);
        this.lastUpdated.set(new Date(data.timestamp));
        this.error.set(null);
      } catch (err) {
        console.error('Failed to parse SSE data', err);
      }
    };

    this.eventSource.onerror = () => {
      console.warn('SSE connection lost. Retrying in 5s...');
      this.closeSSE();
      setTimeout(() => this.setupSSE(), 5000);
    };
  }

  private closeSSE(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  protected refresh(): void {
    this.loading.set(true);
    this.error.set(null);

    this.http
      .get<MetricsResponse>('/api/metrics?fresh=1')
      .pipe(finalize(() => this.loading.set(false)))
      .subscribe({
        next: (response) => {
          this.metrics.set(response);
          this.lastUpdated.set(new Date(response.timestamp));
        },
        error: () => {
          this.error.set('Unable to fetch latest system metrics.');
        }
      });
  }

  protected usageClass(percent: number): string {
    if (percent >= 85) {
      return 'critical';
    }
    if (percent >= 65) {
      return 'warning';
    }
    return 'healthy';
  }

  protected topStorageNode(): TreeNode | null {
    const nodes = this.metrics()?.storageTree ?? [];
    return nodes.length ? nodes[0] : null;
  }

  protected dockerStatusClass(state: string): string {
    return state === 'running' ? 'chip-up' : 'chip-down';
  }

  protected websiteStatusClass(status: 'up' | 'down'): string {
    return status === 'up' ? 'chip-up' : 'chip-down';
  }

  protected toggleTheme(): void {
    const next = !this.isDarkMode();
    this.isDarkMode.set(next);
    this.applyTheme(next);
    localStorage.setItem('stats-theme', next ? 'dark' : 'light');
  }

  protected getContainerStatusColor(state: string): string {
    return state === 'running' ? '#1f7a5a' : '#b33d3d';
  }

  protected getWebsiteResponseClass(ms: number): string {
    if (ms > 500) return 'slow';
    if (ms > 300) return 'medium';
    return 'fast';
  }

  protected trackByContainer(_: number, container: MetricsResponse['docker']['containers'][number]): string {
    return container.name;
  }

  protected trackByEngine(_: number, engine: HealthStatus): string {
    return engine.name;
  }

  protected trackByTreeNode(_: number, rect: TreemapRect): string {
    return rect.node.path;
  }

  protected trackByWebsite(_: number, site: MetricsResponse['websites'][number]): string {
    return site.host;
  }

  private initializeTheme(): void {
    const stored = localStorage.getItem('stats-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const isDark = stored ? stored === 'dark' : prefersDark;
    this.isDarkMode.set(isDark);
    this.applyTheme(isDark);
  }

  private applyTheme(isDark: boolean): void {
    document.body.classList.toggle('dark-theme', isDark);
  }
}
