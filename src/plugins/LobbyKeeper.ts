import { Lobby, Player } from "..";
import { MpSettingsResult } from "../parsers";
import { LobbyPlugin } from "./LobbyPlugin";
import config from "config";
import { Game, User } from "../webapi/HistoryTypes";
import { Mod, ScoreMode, TeamMode } from "../Modes";
import { Logger } from "log4js";

export interface LobbyKeeperOption {
  /**
   * team - 0: Head To Head, 1: Tag Coop, 2: Team Vs, 3: Tag Team Vs
   * score - 0: Score, 1: Accuracy, 2: Combo, 3: Score V2
   */
  mode: { team: TeamMode, score: ScoreMode } | null;

  /**
   * 1-16
   */
  size: number;

  password: string | null;

  /**
   * EZ, NF, HR, SD, DT, NC, FL, HD, FI, Relax, AP, SO, Freemod, None
   */
  mods: Mod[] | null;

  /**
   * Number of kicks until counterattack kick is activated
   */
  hostkick_tolerance: number;

  /**
   * Multiplayer Room Title
   */
  title: string | null;
}

export class LobbyKeeper extends LobbyPlugin {
  option: LobbyKeeperOption;
  kickedUsers: Set<Player>;
  mpKickedUsers: Set<Player>;
  slotKeeper: SlotKeeper;

  constructor(lobby: Lobby, option: Partial<LobbyKeeperOption> = {}) {
    super(lobby, "LobbyKeeper", "keeper");
    const d = config.get<LobbyKeeperOption>(this.pluginName);
    this.option = { ...d, ...option } as LobbyKeeperOption;
    this.kickedUsers = new Set();
    this.mpKickedUsers = new Set();
    this.slotKeeper = new SlotKeeper(this.option.size, this.logger);
    this.convertOptions();

    this.registerEvents();
  }

  private registerEvents(): void {
    this.lobby.JoinedLobby.on(a => this.onJoined())
    this.lobby.HostChanged.on(a => this.onHostChanged(a.player));
    this.lobby.MatchFinished.on(() => this.onMatchFinished());
    this.lobby.ReceivedChatCommand.on(a => this.onChatCommand(a.player, a.command, a.param));
    this.lobby.PlayerJoined.on(a => this.onPlayerJoined(a.slot));
    this.lobby.PlayerLeft.on(a => this.onPlayerLeft(a.player, a.slot));
    this.lobby.PlayerMoved.on(a => this.onPlayerMoved(a.from, a.to));
    this.lobby.ParsedSettings.on(a => this.onParsedSettings(a.result));

    this.lobby.historyRepository.kickedUser.on(a => this.onKickedPlayer(a.kickedUser));
    this.lobby.historyRepository.finishedGame.on(a => this.onFinishedGame(a.game));
  }

  convertOptions() {
    this.setModeOption(this.option.mode);
    this.setSizeOption(this.option.size);
    this.setModsOption(this.option.mods);
  }

  private setModeOption(mode: any) {
    if (mode == null || mode == "null" || mode == "") {
      this.option.mode = null;
      return;
    }

    if (typeof mode == "string") {
      const r = this.tryParseModeParams(mode);
      if (r) {
        this.option.mode = r;
        return;
      } else {
        throw new Error("Invalid Option. LobbyKeeper.mode : " + mode);
      }
    }

    if ("team" in mode && "score" in mode) {
      if ((mode.team instanceof TeamMode) && (mode.score instanceof ScoreMode)) {
        this.option.mode = mode;
      } else {
        this.option.mode = {
          team: TeamMode.from(mode.team.toString(), true),
          score: ScoreMode.from(mode.score.toString(), true)
        };
      }
      return;
    }

    throw new Error("Invalid Option. LobbyKeeper.mode : " + mode);
  }

  private setSizeOption(size: any) {
    if (size == null || size == "null" || size == "") {
      size = 0;
    }
    if (typeof size == "string") {
      size = parseInt(size);
    }

    if (typeof size != "number") {
      throw new Error("invalid size " + size);
    }

    if (size < 0 || 16 < size || isNaN(size)) {
      throw new Error("invalid size " + size);
    }
    this.option.size = size;
    this.slotKeeper.size = size;
  }

  private setModsOption(mods: any) {
    if (mods == null || mods == "null") {
      this.option.mods = null;
      return;
    }
    if (typeof mods == "string") {
      this.option.mods = Mod.parseMods(mods);
      return;
    }
    if (Array.isArray(mods)) {
      mods = mods.filter(m => m).map(m => Mod.from(m.toString()));
      this.option.mods = Mod.removeInvalidCombinations(mods);
      return;
    }
    throw new Error("Invalid Option. LobbyKeeper.mods : " + mods);
  }

  private tryParseModeParams(param: string) {
    const m1 = /^(.+),(.+)$/.exec(param);
    if (m1) {
      try {
        const team = TeamMode.from(m1[1], true);
        const score = ScoreMode.from(m1[2], true);
        return { team, score };
      } catch { }
    }

    const m2 = /^(\S+)\s+(\S+)$/.exec(param);
    if (m2) {
      try {
        const team = TeamMode.from(m2[1], true);
        const score = ScoreMode.from(m2[2], true);
        return { team, score };
      } catch { }
    }

    try {
      const team = TeamMode.from(param, true);
      return { team, score: this.option.mode?.score ?? ScoreMode.Score };
    } catch { }

    try {
      const score = ScoreMode.from(param, true);
      return { team: this.option.mode?.team ?? TeamMode.HeadToHead, score };
    } catch { }

    throw new Error("Invalid Option. LobbyKeeper.mode : " + param);
  }

  private checkMode(teamMode: TeamMode, scoreMode: ScoreMode) {
    if (this.option.mode == null) return false;
    if (this.option.mode.score != scoreMode || this.option.mode.team != teamMode) {
      return true;
    } else {
      return false;
    }
  }

  private checkMods(mods: Mod[]) {
    if (this.option.mods == null) return false;
    const s = new Set(this.option.mods);
    for (const m of mods) {
      if (!s.delete(m)) {
        return true;
      }
    }
    return s.size != 0;
  }

  private checkTitle(title: string | undefined) {
    if (title == null && (this.lobby.historyRepository.hasError || this.option.title != this.lobby.lobbyName)) {
      return true;
    } else if (title != this.option.title) {
      return true;
    }
    return false;
  }

  private fixLobbyModeAndSize(): void {
    if (this.option.mode != null) {
      if (this.option.size) {
        this.lobby.SendMessage(`!mp set ${this.option.mode.team.value} ${this.option.mode.score.value} ${this.option.size}`);
      } else {
        this.lobby.SendMessage(`!mp set ${this.option.mode.team.value} ${this.option.mode.score.value}`);
      }
    } else {
      if (this.option.size) {
        this.lobby.SendMessage(`!mp size ${this.option.size}`);
      }
    }
    this.slotKeeper.resetTimestamp();
  }

  private fixPassword(): void {
    if (this.option.password != null) {
      this.lobby.SendMessage(`!mp password ${this.option.password}`);
    }
  }

  private fixTitle(): void {
    if (this.option.title == null) return;
    //Set title length to max 50
    this.option.title = this.option.title.substring(0, 50);
    this.lobby.SendMessage(`!mp name ${this.option.title}`);
  }

  private fixMods(): void {
    if (this.option.mods != null) {
      this.lobby.SendMessage(`!mp mods ${this.option.mods.map(m => m.value).join(" ")}`)
    }
  }

  private onJoined(): void {
    this.fixTitle();
    this.fixLobbyModeAndSize();
    this.fixMods();
    this.fixPassword();
  }

  private onParsedSettings(result: MpSettingsResult) {
    try {
      const team = TeamMode.from(result.teamMode);
      const score = ScoreMode.from(result.winCondition);
      if (this.checkMode(team, score) || this.slotKeeper.checkMpSettings(result)) {
        this.fixLobbyModeAndSize();
      }

      const mods = Mod.parseMods(result.activeMods);
      if (this.checkMods(mods)) {
        this.fixMods();
      }

      if (this.checkTitle(result.name)) {
        this.fixTitle();
      }

    } catch (e: any) {
      this.logger.error("@LobbyKeeper#onParsedSettings " + e?.message);
    }
  }

  private onPlayerJoined(toSlot: number) {
    if (this.slotKeeper.checkJoin(toSlot)) {
      this.fixLobbyModeAndSize();
    }
  }

  private onPlayerLeft(player: Player, slot: number) {
    if (this.slotKeeper.checkLeave(slot)) {
      this.fixLobbyModeAndSize();
    }
  }

  private onPlayerMoved(fromSlot: number, toSlot: number) {
    if (this.slotKeeper.checkMove(fromSlot, toSlot)) {
      this.fixLobbyModeAndSize();
    }
  }

  private onKickedPlayer(u: User): void {
    if (!this.option.hostkick_tolerance || this.lobby.host == null) return;

    const p = this.lobby.GetPlayer(u.username);
    if (!p || this.mpKickedUsers.has(p)) return;

    this.kickedUsers.add(p);
    this.logger.debug(`added ${p.name} to kickedusers, count: ${this.kickedUsers.size}`);
    if (this.option.hostkick_tolerance <= this.kickedUsers.size || p.isReferee || p.isAuthorized) {
      this.kickedUsers.clear();
      this.mpKickedUsers.clear();
      this.logger.debug(`kick counter activated : ${this.lobby.host.name}`);
      this.lobby.SendMessage(`!mp kick ${this.lobby.host.name}`);
    }
  }

  private onHostChanged(host: Player): void {
    this.kickedUsers.clear();
    this.mpKickedUsers.clear();
  }

  private onChatCommand(player: Player, command: string, param: string): void {
    if (player.isAuthorized) {
      if (command.startsWith("*keep") || command.startsWith("*no")) {
        const msg = this.processCommand(command, param);
        if (msg != null) {
          this.lobby.SendMessage(msg);
          this.logger.info(msg);
        }
      }
    }
  }

  private onMatchFinished(): void {
    this.fixPassword();
    if (this.slotKeeper.checkUnused()) {
      this.fixLobbyModeAndSize();
    }
    if (this.option.title != null || this.option.mode != null || this.option.mods != null) {
      this.lobby.LoadMpSettingsAsync().catch((e: any) => {
        this.logger.error("lobbyKeeper#onMatchFinished failed to LoadMpSettingsAsync");
      });
    }
  }

  private onFinishedGame(game: Game): any {
    this.logger.trace(`hev finished game -> mode:${game.mode}, mode_int:${game.mode_int}, score:${game.scoring_type}, team:${game.team_type}, mods:${game.mods}`);
  }

  private processCommand(command: string, param: string): string | null {
    if (command == "*keep") {
      const matchMode = /^mode(\s+(.+))?\s*$/.exec(param);
      if (matchMode) {
        if (matchMode[2] == undefined) {
          this.logger.warn("missing parameters. *keep mode [0-3] [0-3] e.g. *keep mode 0 0");
          return null;
        }
        try {
          this.setModeOption(matchMode[2]);
          if (this.option.mode) {
            this.fixLobbyModeAndSize();
            return `Keep lobby mode ${this.option.mode.team.name}, ${this.option.mode.score.name}`;
          } else {
            return `Disabled keeping lobby mode`;
          }
        } catch (e: any) {
          this.logger.warn(e?.message ?? "failed to parse mode params");
          return null;
        }
      }

      const matchSize = /^size(\s+(\d+))?\s*$/.exec(param);
      if (matchSize) {
        if (matchSize[2] == undefined) {
          this.logger.warn("missing parameter. *keep size [1-16]");
          return null;
        }
        try {
          this.setSizeOption(matchSize[2]);
          if (this.option.size) {
            this.fixLobbyModeAndSize();
            return `Keep lobby size ${this.option.size}`;
          } else {
            return `Disabled keeping lobby size.`;
          }

        } catch (e: any) {
          this.logger.warn(e?.message ?? "failed to parse size params");
          return null;
        }
      }

      const matchMods = /^mods?(\s+(.+))?\s*$/.exec(param);
      if (matchMods) {
        if (matchMods[2] == undefined) {
          this.logger.warn("missing parameters. *keep mods [mod] ([mod]) ([mod]) ...");
          return null;
        }
        try {
          this.setModsOption(matchMods[2]);
          if (this.option.mods) {
            this.fixMods();
            return `Keep mods ${this.option.mods == null || this.option.mods.length == 0 ? "None" : this.option.mods.map(m => m.name).join(", ")}`;
          } else {
            return `Disabled keeping lobby mods.`;
          }
        } catch (e: any) {
          this.logger.warn(e?.message ?? "failed to parse mods");
          return null;
        }
      }

      const matchPassword = /^password(\s+(.+))?\s*$/.exec(param);
      if (matchPassword) {
        this.option.password = matchPassword[2] !== undefined ? matchPassword[2] : "";
        this.fixPassword();
        return `Keep lobby password ${this.option.password != "" ? this.option.password : "[empty]"}`;
      }

      const matchTitle = /^(title|name)(\s+(.+))?\s*$/.exec(param);
      if (matchTitle) {
        this.option.title = matchTitle[3] !== undefined ? matchTitle[3] : "";
        this.fixTitle();
        return `Keep lobby title ${this.option.title !== "" ? this.option.title : "[empty]"}`;
      }

      this.logger.warn("missing parameters. *keep <mode|size|mods|password|title> ...params");
    }

    if (command == "*no") {
      if (param == "keep mode" && this.option.mode != null) {
        this.setModeOption(null);
        return "disabled keeping teammode and scoremode";
      }
      if (param == "keep size" && this.option.size != 0) {
        this.setSizeOption(0);
        return "disabled keeping lobby size";
      }
      if ((param == "keep mod" || param == "keep mods") && this.option.mods != null) {
        this.setModsOption(null);
        return "disabled keeping mods";
      }
      if (param == "keep password" && this.option.password != null) {
        if (this.option.password != "") {
          this.option.password = "";
          this.fixPassword();
        }
        this.option.password = null;
        return "disabled keeping lobby password";
      }
      if ((param == "keep title" || param == "keep name") && this.option.title != null) {
        this.option.title = null;
        return "disabled keeping room title";
      }

      if (param.startsWith("keep")) {
        this.logger.warn("missing parameters. *no keep <mode|size|mods|password|title>");
      }
    }

    return null;
  }

  getDescription(): string {
    const keeps = [];
    if (this.option.mode) {
      keeps.push(`mode: ${this.option.mode.team.name}, ${this.option.mode.score.name}`);
    }
    if (this.option.size != 0) {
      keeps.push(`size: ${this.option.size}`);
    }

    if (this.option.password) {
      keeps.push(`password: ${this.option.password != "" ? this.option.password : "(empty)"}`);
    }

    if (this.option.mods) {
      keeps.push(`mods: ${this.option.mods.map(m => m.value).join(" ")}`);
    }

    if (this.option.title) {
      keeps.push(`title: ${this.option.title}`);
    }

    return keeps.join(", ");
  }

  GetPluginStatus(): string {
    return `-- Lobby Keeper --
  ${this.getDescription()}`
  }
}

export class SlotKeeper {
  size: number;
  slots: { timestamp: number, hasPlayer: boolean }[];
  logger?: Logger;

  /**
   * スロットがロックされているとみなすまでのミリ秒時間
   */
  timeToConsiderAsLockedSlotMS = 10 * 60 * 1000;

  constructor(size: number = 16, logger?: Logger) {
    this.size = size;
    this.slots = new Array(16).fill(null).map(_ => ({ timestamp: Date.now(), hasPlayer: false }));
    this.logger = logger;
  }

  checkJoin(slot: number) {
    let result = false;
    const idx = slot - 1;
    if (this.size == 0) {
      // do nothing
    } else if (this.size <= idx) {
      result = true;
      // Slots larger than the specified size are open
      this.logger?.trace(`Detected slot expansion. actual size:${slot}, specified size:${this.size}`);

    } else { // 一度に複数のイベントを発生させないために else句を使う
      for (let i = 0; i < idx; i++) {
        // the player didn't enter the slot that shold be empty
        if (!this.slots[i].hasPlayer) {
          result = true;
          this.logger?.trace(`Detected locked slot ${i + 1}`);
          break;
        }
      }
    }

    this.slots[idx].hasPlayer = true;
    this.slots[idx].timestamp = Date.now();
    return result;
  }

  checkLeave(slot: number) {
    const idx = slot - 1;
    this.slots[idx].hasPlayer = false;
    this.slots[idx].timestamp = Date.now();
    return false;
  }

  checkMove(fromSlot: number, toSlot: number) {
    let result = false;
    const fromIdx = fromSlot - 1;
    this.slots[fromIdx].hasPlayer = false;
    this.slots[fromIdx].timestamp = Date.now();

    const toIdx = toSlot - 1;
    if (this.size != 0 && this.size <= toIdx) {
      // Slots larger than the specified size are open
      result = true;
      this.logger?.trace(`Detected slot expansion. actual size:${toSlot}, specified size:${this.size}`);
    }

    this.slots[toIdx].hasPlayer = true;
    this.slots[toIdx].timestamp = Date.now();
    return result;
  }

  checkUnused() {
    if (this.size == 0) return false;

    const now = Date.now();
    let estematedSize = -1;
    let lockedSlot = -1;

    for (let i = 0; i < this.size; i++) {
      if (!this.slots[i].hasPlayer) {
        const durationEmpty = now - this.slots[i].timestamp;
        if (lockedSlot == -1 && this.timeToConsiderAsLockedSlotMS <= durationEmpty) {
          lockedSlot = i + 1;
          continue;
        }
      }
      estematedSize = i + 1;
    }

    if (lockedSlot != -1) {
      this.logger?.trace(`Detected locked slot ${lockedSlot}`);
      return true;
    } else {
      return false;
    }
  }

  resetTimestamp() {
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
      this.slots[i].timestamp = now;
    }
  }

  checkMpSettings(setting: MpSettingsResult) {
    for (let idx = 0; idx < 16; idx++) {
      this.slots[idx].hasPlayer = false;
    }

    let result = false;
    for (const ps of setting.players) {
      const idx = ps.slot - 1;
      this.slots[idx].hasPlayer = true;
      this.slots[idx].timestamp = Date.now();
      if (this.size != 0 && this.size < ps.slot) {
        result = true;
      }
    }

    return result;
  }
}