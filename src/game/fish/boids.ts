/**
 * Boids tuning + the uniform-grid spatial hash used for neighbour lookups.
 *
 * [PURE] This runs inside the Node.js game server at 60 Hz with up to 200 fish,
 * so there is no 'three', no browser global, and — after construction — not a
 * single allocation. Every buffer is a typed array that lives for the whole
 * round and is rebuilt in place by 'clear()'.
 */

export interface BoidWeights {
  separation: number;
  alignment: number;
  cohesion: number;
  separationRadius: number;
  neighborRadius: number;
}

export const DEFAULT_BOID_WEIGHTS: BoidWeights = {
  /**
   * Separation is deliberately the dominant term and is NOT scaled by the
   * per-species 'schooling' value: fish that interpenetrate read as one blob
   * from across a room, which destroys the illusion instantly.
   */
  separation: 2.05,
  alignment: 0.9,
  cohesion: 0.62,
  /** Roughly one body length for the mid-size species. */
  separationRadius: 0.46,
  /** Kept below the grid cell size so a query only ever touches 2x2x2 cells. */
  neighborRadius: 1.15,
};

/** Grid cells smaller than this would make the index arithmetic meaningless. */
const MIN_CELL = 1e-3;
/** Initial entry capacity; grows geometrically and then never again. */
const INITIAL_ENTRIES = 256;

const clampIndex = (v: number, n: number): number => (v < 0 ? 0 : v >= n ? n - 1 : v);

/**
 * Uniform-grid spatial hash over a fixed AABB.
 *
 * Backed by a counting sort: 'insert()' only tallies a per-cell count, and the
 * first 'query()' after an insert builds the prefix-summed 'bucket' array in
 * one linear pass. That keeps each cell's members contiguous in memory, which
 * is what makes the boids inner loop cheap. The intended usage is therefore
 * "clear -> insert everything -> query many times"; interleaving inserts and
 * queries stays correct but pays for a rebuild each time.
 *
 * Positions outside the AABB are clamped into the edge cells rather than
 * rejected, so a fish that has been flung above the water line (a dropped fish
 * falling back in) can never index outside the arrays.
 */
export class SpatialHash {
  private readonly originX: number;
  private readonly originY: number;
  private readonly originZ: number;
  private readonly invCell: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly nz: number;
  private readonly cellCount: number;

  /** Number of entries per cell, reset by 'clear()'. */
  private readonly counts: Int32Array;
  /** Prefix sum of 'counts'; 'starts[c]..starts[c+1]' is cell 'c''s run. */
  private readonly starts: Int32Array;
  /** Scatter cursor used while building 'bucket'. */
  private readonly cursor: Int32Array;

  private entryCell: Int32Array;
  private entryIndex: Int32Array;
  private bucket: Int32Array;

  private entryCount = 0;
  private dirty = false;

  constructor(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    cell: number,
  ) {
    const size = Math.max(cell, MIN_CELL);
    const lox = Math.min(minX, maxX);
    const loy = Math.min(minY, maxY);
    const loz = Math.min(minZ, maxZ);
    const hix = Math.max(minX, maxX);
    const hiy = Math.max(minY, maxY);
    const hiz = Math.max(minZ, maxZ);

    this.originX = lox;
    this.originY = loy;
    this.originZ = loz;
    this.invCell = 1 / size;
    this.nx = Math.max(1, Math.ceil((hix - lox) / size));
    this.ny = Math.max(1, Math.ceil((hiy - loy) / size));
    this.nz = Math.max(1, Math.ceil((hiz - loz) / size));
    this.cellCount = this.nx * this.ny * this.nz;

    this.counts = new Int32Array(this.cellCount);
    this.starts = new Int32Array(this.cellCount + 1);
    this.cursor = new Int32Array(this.cellCount);
    this.entryCell = new Int32Array(INITIAL_ENTRIES);
    this.entryIndex = new Int32Array(INITIAL_ENTRIES);
    this.bucket = new Int32Array(INITIAL_ENTRIES);
  }

  clear(): void {
    this.counts.fill(0);
    this.entryCount = 0;
    this.dirty = false;
  }

  insert(index: number, x: number, y: number, z: number): void {
    const cell = this.cellOf(x, y, z);
    const n = this.entryCount;
    if (n >= this.entryCell.length) this.grow(n + 1);
    this.entryCell[n] = cell;
    this.entryIndex[n] = index;
    this.counts[cell] += 1;
    this.entryCount = n + 1;
    this.dirty = true;
  }

  /** Fills 'out' with indices in cells overlapping the sphere; returns the count. */
  query(x: number, y: number, z: number, radius: number, out: Int32Array): number {
    if (this.entryCount === 0) return 0;
    if (this.dirty) this.build();

    const r = radius < 0 ? 0 : radius;
    const inv = this.invCell;
    const x0 = clampIndex(Math.floor((x - r - this.originX) * inv), this.nx);
    const x1 = clampIndex(Math.floor((x + r - this.originX) * inv), this.nx);
    const y0 = clampIndex(Math.floor((y - r - this.originY) * inv), this.ny);
    const y1 = clampIndex(Math.floor((y + r - this.originY) * inv), this.ny);
    const z0 = clampIndex(Math.floor((z - r - this.originZ) * inv), this.nz);
    const z1 = clampIndex(Math.floor((z + r - this.originZ) * inv), this.nz);

    const limit = out.length;
    const nx = this.nx;
    const nxy = nx * this.ny;
    let count = 0;

    for (let cz = z0; cz <= z1; cz++) {
      const zBase = cz * nxy;
      for (let cy = y0; cy <= y1; cy++) {
        const rowBase = zBase + cy * nx;
        for (let cx = x0; cx <= x1; cx++) {
          const cell = rowBase + cx;
          const end = this.starts[cell + 1];
          for (let k = this.starts[cell]; k < end; k++) {
            if (count >= limit) return count;
            out[count++] = this.bucket[k];
          }
        }
      }
    }
    return count;
  }

  private cellOf(x: number, y: number, z: number): number {
    const inv = this.invCell;
    // NaN floors to NaN, which 'clampIndex' turns into the far edge; the
    // 'v < 0' test fails and 'v >= n' fails, so guard it explicitly.
    const rx = Math.floor((x - this.originX) * inv);
    const ry = Math.floor((y - this.originY) * inv);
    const rz = Math.floor((z - this.originZ) * inv);
    const cx = rx >= 0 ? clampIndex(rx, this.nx) : 0;
    const cy = ry >= 0 ? clampIndex(ry, this.ny) : 0;
    const cz = rz >= 0 ? clampIndex(rz, this.nz) : 0;
    return (cz * this.ny + cy) * this.nx + cx;
  }

  private build(): void {
    const cells = this.cellCount;
    const n = this.entryCount;
    if (this.bucket.length < n) this.bucket = new Int32Array(this.entryCell.length);

    let running = 0;
    for (let c = 0; c < cells; c++) {
      this.starts[c] = running;
      this.cursor[c] = running;
      running += this.counts[c];
    }
    this.starts[cells] = running;

    for (let e = 0; e < n; e++) {
      const cell = this.entryCell[e];
      this.bucket[this.cursor[cell]] = this.entryIndex[e];
      this.cursor[cell] += 1;
    }
    this.dirty = false;
  }

  private grow(needed: number): void {
    let size = this.entryCell.length;
    while (size < needed) size *= 2;
    const cells = new Int32Array(size);
    const idx = new Int32Array(size);
    cells.set(this.entryCell);
    idx.set(this.entryIndex);
    this.entryCell = cells;
    this.entryIndex = idx;
    this.bucket = new Int32Array(size);
  }
}
