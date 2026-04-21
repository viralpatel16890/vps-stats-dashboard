import { DatePipe, DecimalPipe, NgClass, PercentPipe, TitleCasePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
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
    uptimeLabel?: string;
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
    NgClass,
    TitleCasePipe,
    DatePipe,
    PercentPipe,
    DecimalPipe,
    MatButtonModule,
    MatCardModule,
    MatChipsModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    MatIconModule,
    MatTooltipModule
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class App implements OnInit, OnDestroy {
  private readonly http = inject(HttpClient);
  private eventSource: EventSource | null = null;
  private visibilityListener: (() => void) | null = null;

  protected readonly title = signal('Stats Control Deck');
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  
  // Granular Signals
  protected readonly cpu = signal<MetricsResponse['cpu'] | null>(null);
  protected readonly memory = signal<MetricsResponse['memory'] | null>(null);
  protected readonly disk = signal<MetricsResponse['disk'] | null>(null);
  protected readonly docker = signal<MetricsResponse['docker'] | null>(null);
  protected readonly database = signal<MetricsResponse['database'] | null>(null);
  protected readonly storageTree = signal<MetricsResponse['storageTree']>([]);
  protected readonly websites = signal<MetricsResponse['websites']>([]);
  
  protected readonly lastUpdated = signal<Date | null>(null);
  protected readonly selectedNode = signal<TreeNode | null>(null);

  protected readonly treemapLayout = computed(() => {
    const nodes = this.storageTree();
    if (!nodes.length) return [];

    const rects: TreemapRect[] = [];
    
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
        const leftWidth = width * ratio;
        compute(leftItems, x, y, leftWidth, height);
        compute(rightItems, x + leftWidth, y, width - leftWidth, height);
      } else {
        const leftHeight = height * ratio;
        compute(leftItems, x, y, width, leftHeight);
        compute(rightItems, x, y + leftHeight, width, height - leftHeight);
      }
    };

    compute(nodes, 0, 0, 100, 100);
    return rects;
  });

  protected readonly healthStatus = computed(() => {
    const cpu = this.cpu();
    const memory = this.memory();
    const disk = this.disk();
    const docker = this.docker();
    const database = this.database();
    const websites = this.websites();

    if (!cpu || !memory || !disk || !docker || !database) {
      return { color: 'gray', text: 'Loading', details: 'Fetching system metrics...' };
    }

    const issues: string[] = [];
    if (cpu.usagePercent >= 85) issues.push('High CPU Usage');
    if (memory.usagePercent >= 85) issues.push('High Memory Usage');
    if (disk.usagePercent >= 85) issues.push('Low Disk Space');
    if (docker.stoppedCount > 0) issues.push(`${docker.stoppedCount} Docker Containers Stopped`);
    if (database.overall === 'down') issues.push('Database Engines Offline');
    const downSites = websites.filter((w) => w.status === 'down').length;
    if (downSites > 0) issues.push(`${downSites} Websites Offline`);

    if (issues.length >= 3) {
      return { color: '#b33d3d', text: 'Critical', details: issues.join(', ') };
    }
    if (issues.length >= 1) {
      return { color: '#a26d1f', text: 'Caution', details: issues.join(', ') };
    }
    return { color: '#1f7a5a', text: 'Healthy', details: 'All systems operational' };
  });

  ngOnInit(): void {
    this.refresh();
    this.setupSSE();
    this.setupVisibilityThrottling();
  }

  ngOnDestroy(): void {
    this.closeSSE();
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
  }

  private setupVisibilityThrottling(): void {
    this.visibilityListener = () => {
      if (document.visibilityState === 'visible') {
        this.setupSSE();
      } else {
        this.closeSSE();
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  private setupSSE(): void {
    if (this.eventSource) return;
    
    this.eventSource = new EventSource('/api/events');

    this.eventSource.onmessage = (event) => {
      try {
        const data: MetricsResponse = JSON.parse(event.data);
        this.updateSignals(data);
        this.error.set(null);
      } catch (err) {
        console.error('Failed to parse SSE data', err);
      }
    };

    this.eventSource.onerror = () => {
      console.warn('SSE connection lost. Retrying in 5s...');
      this.closeSSE();
      setTimeout(() => {
        if (document.visibilityState === 'visible') {
          this.setupSSE();
        }
      }, 5000);
    };
  }

  private updateSignals(data: MetricsResponse): void {
    this.cpu.set(data.cpu);
    this.memory.set(data.memory);
    this.disk.set(data.disk);
    this.docker.set(data.docker);
    this.database.set(data.database);
    this.storageTree.set(data.storageTree);
    this.websites.set(data.websites);
    this.lastUpdated.set(new Date(data.timestamp));
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
          this.updateSignals(response);
        },
        error: () => {
          this.error.set('Unable to fetch latest system metrics.');
        }
      });
  }

  protected usageClass(percent: number): string {
    if (percent >= 85) return 'critical';
    if (percent >= 65) return 'warning';
    return 'healthy';
  }

  protected dockerStatusClass(state: string): string {
    return state === 'running' ? 'chip-up' : 'chip-down';
  }

  protected websiteStatusClass(status: 'up' | 'down'): string {
    return status === 'up' ? 'chip-up' : 'chip-down';
  }

  protected getContainerStatusColor(state: string): string {
    return state === 'running' ? '#1f7a5a' : '#b33d3d';
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
}
