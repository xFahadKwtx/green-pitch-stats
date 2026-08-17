import type {
  KeeperMonthStats,
  KeeperPlayer,
  MonthKey,
  OutfieldMonthStats,
  OutfieldPlayer,
  Player,
} from "./types";

/** [gp, mvp, goals, assists, shots, sot, passes, passesCompleted, tackles, clearances, dribbles, keyPasses, chances, avg, high] */
type OutRow = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
/** [gp, mvp, saves, shotsFaced, conceded, avg, high] */
type GkRow = [number, number, number, number, number, number, number];

const out = (r: OutRow): OutfieldMonthStats => ({
  gamesPlayed: r[0],
  mvpAwards: r[1],
  goals: r[2],
  assists: r[3],
  shots: r[4],
  shotsOnTarget: r[5],
  passes: r[6],
  passesCompleted: r[7],
  tackles: r[8],
  clearances: r[9],
  dribbles: r[10],
  keyPasses: r[11],
  chancesCreated: r[12],
  avgRating: r[13],
  highestRating: r[14],
});

const gk = (r: GkRow): KeeperMonthStats => ({
  gamesPlayed: r[0],
  mvpAwards: r[1],
  saves: r[2],
  shotsFaced: r[3],
  goalsConceded: r[4],
  avgRating: r[5],
  highestRating: r[6],
});

const outfield = (
  id: string,
  name: string,
  nameAr: string,
  position: OutfieldPlayer["position"],
  points: number,
  rows: Partial<Record<MonthKey, OutRow>>,
): OutfieldPlayer => ({
  id,
  name,
  nameAr,
  position,
  points,
  stats: Object.fromEntries(
    Object.entries(rows).map(([m, r]) => [m, out(r as OutRow)]),
  ) as OutfieldPlayer["stats"],
});

const keeper = (
  id: string,
  name: string,
  nameAr: string,
  points: number,
  rows: Partial<Record<MonthKey, GkRow>>,
): KeeperPlayer => ({
  id,
  name,
  nameAr,
  position: "GK",
  points,
  stats: Object.fromEntries(
    Object.entries(rows).map(([m, r]) => [m, gk(r as GkRow)]),
  ) as KeeperPlayer["stats"],
});

export const players: Player[] = [
  outfield("fahad-alshabaan", "Fahad Alshabaan", "فهد الشعبان", "FWD", 320, {
    "2026-06": [6, 2, 9, 4, 24, 15, 210, 176, 7, 3, 14, 9, 12, 8.1, 9.3],
    "2026-07": [7, 1, 8, 6, 27, 16, 244, 201, 9, 4, 17, 11, 15, 7.9, 9.0],
    "2026-08": [5, 2, 7, 3, 19, 12, 168, 141, 5, 2, 11, 7, 9, 8.3, 9.4],
  }),
  outfield("yousef-almatar", "Yousef Almatar", "يوسف المطر", "FWD", 265, {
    "2026-06": [5, 1, 7, 2, 21, 13, 152, 118, 4, 1, 9, 5, 7, 7.6, 8.8],
    "2026-07": [6, 0, 9, 3, 26, 17, 173, 137, 6, 2, 12, 6, 8, 7.8, 8.9],
    "2026-08": [6, 1, 6, 5, 22, 12, 181, 149, 7, 3, 10, 8, 11, 7.7, 8.6],
  }),
  outfield("abdullah-alenezi", "Abdullah Alenezi", "عبدالله العنزي", "MID", 298, {
    "2026-06": [6, 1, 3, 8, 14, 8, 312, 284, 12, 5, 13, 15, 18, 8.2, 9.1],
    "2026-07": [7, 2, 4, 9, 17, 9, 366, 336, 15, 6, 16, 18, 21, 8.4, 9.5],
    "2026-08": [6, 0, 2, 7, 11, 6, 298, 271, 13, 4, 12, 14, 16, 8.0, 8.8],
  }),
  outfield("mohammed-alsaleh", "Mohammed Alsaleh", "محمد الصالح", "MID", 241, {
    "2026-06": [5, 0, 2, 5, 12, 6, 268, 233, 14, 7, 8, 10, 12, 7.5, 8.4],
    "2026-07": [6, 1, 3, 6, 15, 8, 305, 268, 17, 8, 9, 12, 14, 7.7, 8.7],
    "2026-08": [5, 0, 1, 4, 9, 4, 241, 210, 12, 6, 7, 9, 10, 7.4, 8.2],
  }),
  outfield("salem-alrashidi", "Salem Alrashidi", "سالم الرشيدي", "MID", 187, {
    "2026-06": [4, 0, 1, 3, 8, 4, 190, 171, 9, 4, 6, 7, 8, 7.2, 8.0],
    "2026-07": [5, 0, 2, 4, 11, 6, 232, 209, 11, 5, 8, 9, 10, 7.4, 8.3],
    "2026-08": [4, 1, 3, 2, 12, 7, 178, 160, 8, 3, 7, 6, 7, 7.9, 8.9],
  }),
  outfield("ali-alqallaf", "Ali Alqallaf", "علي القلاف", "DEF", 254, {
    "2026-06": [6, 0, 1, 2, 6, 3, 224, 196, 24, 19, 4, 3, 4, 7.8, 8.6],
    "2026-07": [7, 1, 0, 3, 5, 2, 261, 231, 29, 23, 5, 4, 5, 8.0, 8.9],
    "2026-08": [6, 0, 1, 1, 4, 2, 219, 189, 22, 17, 3, 2, 3, 7.7, 8.4],
  }),
  outfield("hamad-alfadhli", "Hamad Alfadhli", "حمد الفضلي", "DEF", 212, {
    "2026-06": [5, 0, 0, 1, 4, 1, 181, 152, 21, 16, 2, 2, 2, 7.4, 8.1],
    "2026-07": [6, 0, 1, 2, 6, 3, 214, 181, 26, 21, 3, 3, 4, 7.6, 8.5],
    "2026-08": [5, 1, 0, 1, 3, 1, 176, 150, 24, 18, 2, 1, 2, 7.8, 8.8],
  }),
  outfield("nasser-alhajri", "Nasser Alhajri", "ناصر الهاجري", "DEF", 176, {
    "2026-06": [4, 0, 0, 1, 3, 1, 142, 118, 16, 13, 1, 1, 2, 7.1, 7.9],
    "2026-07": [5, 0, 0, 0, 2, 1, 168, 141, 19, 15, 2, 1, 1, 7.3, 8.0],
    "2026-08": [4, 0, 1, 1, 4, 2, 136, 114, 15, 12, 2, 2, 2, 7.2, 8.1],
  }),
  outfield("bader-alazmi", "Bader Alazmi", "بدر العازمي", "FWD", 198, {
    "2026-06": [4, 0, 5, 1, 16, 9, 108, 82, 3, 1, 7, 3, 4, 7.3, 8.2],
    "2026-07": [5, 1, 6, 2, 19, 11, 131, 101, 4, 2, 9, 4, 5, 7.6, 8.7],
    "2026-08": [4, 0, 4, 3, 14, 8, 112, 88, 3, 1, 6, 5, 6, 7.5, 8.3],
  }),
  outfield("khaled-almutairi", "Khaled Almutairi", "خالد المطيري", "MID", 231, {
    "2026-06": [5, 1, 4, 4, 15, 9, 246, 218, 11, 4, 10, 11, 13, 7.9, 8.8],
    "2026-07": [6, 0, 3, 5, 17, 10, 288, 254, 13, 5, 12, 13, 15, 7.8, 8.6],
    "2026-08": [6, 1, 5, 4, 20, 12, 272, 241, 12, 5, 13, 12, 14, 8.1, 9.0],
  }),
  outfield("saud-aldosari", "Saud Aldosari", "سعود الدوسري", "DEF", 164, {
    "2026-07": [4, 0, 0, 1, 3, 1, 151, 129, 18, 14, 2, 2, 2, 7.2, 8.0],
    "2026-08": [5, 0, 1, 2, 5, 2, 186, 160, 21, 16, 3, 3, 3, 7.5, 8.4],
  }),
  outfield("omar-alkandari", "Omar Alkandari", "عمر الكندري", "FWD", 149, {
    "2026-06": [3, 0, 3, 1, 11, 6, 74, 55, 2, 1, 5, 2, 3, 7.1, 7.8],
    "2026-08": [4, 0, 4, 2, 15, 8, 96, 74, 3, 1, 6, 3, 4, 7.4, 8.2],
  }),
  keeper("jassim-alansari", "Jassim Alansari", "جاسم الأنصاري", 276, {
    "2026-06": [6, 1, 31, 39, 8, 8.0, 9.0],
    "2026-07": [7, 1, 38, 49, 11, 7.9, 8.8],
    "2026-08": [6, 2, 34, 41, 7, 8.4, 9.6],
  }),
  keeper("faisal-alsabah", "Faisal Alsabah", "فيصل الصباح", 203, {
    "2026-06": [5, 0, 22, 30, 8, 7.5, 8.3],
    "2026-07": [5, 1, 27, 34, 7, 7.9, 8.9],
    "2026-08": [5, 0, 24, 33, 9, 7.6, 8.5],
  }),
];

export const getPlayerById = (id: string): Player | undefined =>
  players.find((p) => p.id === id);
