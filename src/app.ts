import type { Event } from 'nostr-tools/core'
import type { Filter } from 'nostr-tools/filter'
import * as nip19 from 'nostr-tools/nip19'
import { generateAesKey } from './crypto/aes'
import {
  checkZapSupport,
  fetchPayParams,
  isLightningAddress,
  MAX_REWARD_ADDRESS_CHARS,
  requestInvoice,
  type LnurlPayParams,
} from './lightning/lnurl'
import { copyToClipboard, invoiceQrDataUrl } from './lightning/qr'
import {
  buildAdminActionTemplate,
  buildCommentTemplate,
  buildPoolTemplate,
  buildShareHash,
  foldAdminActions,
  parseComment,
  parsePoolEvent,
  parseShareHash,
  type PoolStatus,
  type ShareRef,
} from './nostr/events'
import {
  createEphemeralSession,
  createNewKeys,
  hasExtension,
  loadSession,
  loginWithExtension,
  loginWithNsec,
  logout,
  nip44DecryptFrom,
  nip44EncryptTo,
  npubOf,
  nsecOf,
  randomAnonName,
  signEvent,
  type Session,
} from './nostr/keys'
import {
  buildProfileTemplate,
  DEFAULT_RELAYS,
  fetchEventById,
  fetchProfile,
  fetchProfiles,
  fetchRawProfile,
  fetchWriteRelays,
  invalidateProfile,
  mergeRelays,
  pool as relayPool,
  publishToRelays,
} from './nostr/relays'
import { BLOSSOM_SERVERS, uploadToBlossom } from './nostr/blossom'
import { buildZapRequestTemplate, padRewardAddress, parseZapReceipt, unpadRewardAddress } from './nostr/zaps'
import { computePayouts, computeRefunds, totalPotSats, totalsByOption } from './payouts'
import type { Bet, Payout, Pool, PoolComment, Profile } from './types'
import { DEFAULTS, KIND_ADMIN_ACTION, KIND_COMMENT, KIND_ZAP_RECEIPT } from './types'
import { BACKGROUNDS, shippedBackgroundUrl } from './ui/backgrounds'

type Route = 'home' | 'create' | 'pool'

const DISCLAIMER_KEY = 'bwf.disclaimerAccepted'

interface SubCloser {
  close(): void
}

export function createApp() {
  return {
    // ---- routing ----
    route: 'home' as Route,

    // ---- disclaimer ----
    disclaimerAccepted: false,

    // ---- session ----
    session: null as Session | null,
    myProfile: null as Profile | null,
    accountMenuOpen: false,

    // ---- login modal ----
    login: {
      open: false,
      mode: 'menu' as 'menu' | 'nsec' | 'new' | 'backup',
      /** 'bet' when opened from a bet attempt: offers the anonymous option and resumes the bet. */
      context: 'general' as 'general' | 'bet',
      nsecInput: '',
      newName: '',
      newLud16: '',
      backupNsec: '',
      backupConfirmed: false,
      busy: false,
      error: '',
    },

    // ---- create form ----
    form: {
      title: '',
      description: '',
      imageUrl: '',
      imageUrlValidated: '',
      imageUrlError: '',
      imageUploading: false,
      imageUploadOpen: false,
      imageDragActive: false,
      backgroundId: '',
      customBackgroundUrl: '',
      customBgValidated: '',
      customBgError: '',
      bgUploading: false,
      bgUploadOpen: false,
      bgDragActive: false,
      blossomServerId: BLOSSOM_SERVERS[0]!.id,
      options: [
        { title: '', description: '' },
        { title: '', description: '' },
        { title: '', description: '' },
      ],
      adminFeePct: DEFAULTS.adminFeePct,
      maxBets: DEFAULTS.maxBets,
      maxBetSats: DEFAULTS.maxBetSats,
      deadlineLocal: '',
      showAdvanced: false,
      relaysText: DEFAULT_RELAYS.join('\n'),
    },
    wallet: {
      state: 'idle' as 'idle' | 'checking' | 'ok' | 'missing' | 'bad',
      lud16: '',
      reason: '',
      newLud16: '',
      saving: false,
      saveError: '',
    },
    creating: false,
    createError: '',

    // ---- pool view ----
    poolRef: null as ShareRef | null,
    pool: null as Pool | null,
    poolLoading: false,
    poolError: '',
    adminProfile: null as Profile | null,
    adminParams: null as LnurlPayParams | null,
    bets: [] as Bet[],
    seenReceipts: new Set<string>(),
    actionEvents: [] as Event[],
    status: { closed: false, winnerOptionId: null, cancelled: false, paidReceiptIds: new Set() } as PoolStatus,
    comments: [] as PoolComment[],
    profiles: {} as Record<string, Profile>,
    sub: null as SubCloser | null,
    nowSec: Math.floor(Date.now() / 1000),
    ticker: 0 as ReturnType<typeof setInterval> | 0,
    pendingBetOption: '',
    pendingBetDraft: null as { amount: string | number; rewardAddress: string } | null,
    /** Throwaway identity for anonymous zaps — page-scoped, never a real login. */
    betSession: null as Session | null,
    betAnonName: '',
    lastRewardAddress: '',
    commentText: '',
    postingComment: false,
    copied: '',

    // ---- bet modal ----
    bet: {
      open: false,
      optionId: '',
      amount: '' as string | number,
      rewardAddress: '',
      state: 'form' as 'creating' | 'form' | 'invoice' | 'paid',
      invoice: '',
      qr: '',
      requestId: '',
      busy: false,
      error: '',
    },

    // ---- admin settlement ----
    winnerPick: '',
    adminBusy: false,
    adminError: '',
    /** Admin-only cache: receiptId → decrypted reward address (or an error marker). */
    decryptedAddresses: {} as Record<string, string>,
    payoutModal: {
      open: false,
      payout: null as Payout | null,
      address: '',
      invoice: '',
      qr: '',
      busy: false,
      error: '',
    },

    // ================= lifecycle =================

    async init() {
      this.disclaimerAccepted = localStorage.getItem(DISCLAIMER_KEY) === '1'
      this.session = loadSession()
      if (this.session) void this.loadMyProfile()
      window.addEventListener('hashchange', () => this.handleRoute())
      // Mobile browsers can suspend a backgrounded tab's websocket (e.g. while
      // the user is away paying an invoice in their wallet app), so the live
      // subscription can silently miss events. Catch up whenever the tab
      // becomes visible again.
      document.addEventListener('visibilitychange', () => this.handleVisible())
      window.addEventListener('pageshow', () => this.handleVisible())
      this.handleRoute()
    },

    handleVisible() {
      if (document.visibilityState !== 'visible') return
      if (this.route === 'pool' && this.pool) void this.refreshPoolEvents()
    },

    handleRoute() {
      const hash = window.location.hash
      this.teardownPool()
      if (hash.startsWith('#/p/')) {
        this.route = 'pool'
        void this.loadPool()
      } else if (hash === '#/create') {
        this.route = 'create'
        void this.prepareCreate()
      } else {
        this.route = 'home'
      }
    },

    acceptDisclaimer() {
      this.disclaimerAccepted = true
      localStorage.setItem(DISCLAIMER_KEY, '1')
    },

    // ================= session =================

    openLogin(context: 'general' | 'bet' = 'general') {
      this.login = { ...this.login, open: true, mode: 'menu', context, nsecInput: '', newName: '', newLud16: '', error: '', busy: false }
    },

    hasExtension(): boolean {
      return hasExtension()
    },

    async doExtensionLogin() {
      this.login.busy = true
      this.login.error = ''
      try {
        this.session = await loginWithExtension()
        this.login.open = false
        void this.loadMyProfile()
        this.afterLogin()
      } catch (e) {
        this.login.error = errMsg(e)
      } finally {
        this.login.busy = false
      }
    },

    doNsecLogin() {
      this.login.error = ''
      try {
        this.session = loginWithNsec(this.login.nsecInput)
        this.login.nsecInput = ''
        this.login.open = false
        void this.loadMyProfile()
        this.afterLogin()
      } catch (e) {
        this.login.error = errMsg(e)
      }
    },

    /** Creates fresh keys and shows the mandatory nsec-backup step. */
    doCreateProfile() {
      this.login.error = ''
      const name = this.login.newName.trim()
      const lud16 = this.login.newLud16.trim()
      if (!name) {
        this.login.error = 'Enter a display name'
        return
      }
      if (lud16 && !isLightningAddress(lud16)) {
        this.login.error = 'Enter a valid lightning address (name@wallet.com), or leave it empty'
        return
      }
      this.session = createNewKeys('generated')
      this.login.backupNsec = nsecOf(this.session) ?? ''
      this.login.backupConfirmed = false
      this.login.mode = 'backup'
      void this.publishOwnProfile({ name, ...(lud16 ? { lud16 } : {}) })
    },

    finishBackup() {
      if (!this.login.backupConfirmed) return
      this.login.open = false
      this.afterLogin()
    },

    afterLogin() {
      if (this.login.context === 'bet' && this.pendingBetOption) {
        // A real login replaces any temporary anonymous zap identity.
        this.betSession = null
        this.betAnonName = ''
        const optionId = this.pendingBetOption
        this.pendingBetOption = ''
        this.openBetModal(optionId)
        if (this.pendingBetDraft) {
          this.bet.amount = this.pendingBetDraft.amount
          if (this.pendingBetDraft.rewardAddress) this.bet.rewardAddress = this.pendingBetDraft.rewardAddress
          this.pendingBetDraft = null
        }
      }
      if (this.route === 'create') void this.prepareCreate()
    },

    doLogout() {
      logout()
      this.session = null
      this.myProfile = null
      this.accountMenuOpen = false
    },

    myNpub(): string {
      return this.session ? npubOf(this.session) : ''
    },

    async loadMyProfile() {
      if (!this.session) return
      try {
        this.myProfile = await fetchProfile(this.session.pubkey, DEFAULT_RELAYS)
      } catch {
        this.myProfile = { pubkey: this.session.pubkey }
      }
    },

    async publishOwnProfile(fields: Record<string, unknown>) {
      if (!this.session) return
      const existing = await fetchRawProfile(this.session.pubkey, DEFAULT_RELAYS).catch(() => ({
        content: {},
        createdAt: 0,
      }))
      const content = { ...existing.content, ...fields }
      const signed = await signEvent(this.session, buildProfileTemplate(content, existing.createdAt))
      await publishToRelays(DEFAULT_RELAYS, signed)
      invalidateProfile(this.session.pubkey)
      await this.loadMyProfile()
    },

    // ================= create pool =================

    async prepareCreate() {
      this.createError = ''
      if (!this.session) return
      // Merge the admin's NIP-65 write relays into the prefilled relay list.
      try {
        const mine = await fetchWriteRelays(this.session.pubkey, DEFAULT_RELAYS)
        if (mine.length > 0) {
          this.form.relaysText = mergeRelays(this.form.relaysText.split('\n'), mine).join('\n')
        }
      } catch {
        // keep defaults
      }
      await this.checkWallet()
    },

    async checkWallet() {
      if (!this.session) return
      this.wallet.state = 'checking'
      this.wallet.reason = ''
      try {
        const profile = await fetchProfile(this.session.pubkey, DEFAULT_RELAYS)
        this.myProfile = profile
        const address = profile.lud16 ?? profile.lud06
        if (!address) {
          this.wallet.state = 'missing'
          return
        }
        this.wallet.lud16 = address
        const params = await fetchPayParams(address)
        const support = checkZapSupport(params)
        if (support.ok) {
          this.wallet.state = 'ok'
        } else {
          this.wallet.state = 'bad'
          this.wallet.reason = support.reason ?? ''
        }
      } catch (e) {
        this.wallet.state = 'bad'
        this.wallet.reason = errMsg(e)
      }
    },

    async saveWalletAddress() {
      const address = this.wallet.newLud16.trim()
      this.wallet.saveError = ''
      if (!isLightningAddress(address)) {
        this.wallet.saveError = 'Enter a valid lightning address, like name@wallet.com'
        return
      }
      this.wallet.saving = true
      try {
        // Validate the address actually works before writing it to the profile.
        const params = await fetchPayParams(address)
        const support = checkZapSupport(params)
        if (!support.ok) throw new Error(support.reason)
        await this.publishOwnProfile({ lud16: address })
        this.wallet.newLud16 = ''
        await this.checkWallet()
      } catch (e) {
        this.wallet.saveError = errMsg(e)
      } finally {
        this.wallet.saving = false
      }
    },

    /** Back to defaults so the next pool doesn't silently inherit old values. */
    resetForm() {
      this.form = {
        ...this.form,
        title: '',
        description: '',
        imageUrl: '',
        imageUrlValidated: '',
        imageUrlError: '',
        imageUploading: false,
        imageUploadOpen: false,
        imageDragActive: false,
        backgroundId: '',
        customBackgroundUrl: '',
        customBgValidated: '',
        customBgError: '',
        bgUploading: false,
        bgUploadOpen: false,
        bgDragActive: false,
        options: [
          { title: '', description: '' },
          { title: '', description: '' },
          { title: '', description: '' },
        ],
        adminFeePct: DEFAULTS.adminFeePct,
        maxBets: DEFAULTS.maxBets,
        maxBetSats: DEFAULTS.maxBetSats,
        deadlineLocal: '',
      }
    },

    addOption() {
      this.form.options.push({ title: '', description: '' })
    },

    optionPlaceholder(index: number): string {
      return ['e.g. Real Madrid', 'e.g. Manchester United', 'e.g. Tie'][index] ?? ''
    },

    removeOption(index: number) {
      if (this.form.options.length > 2) this.form.options.splice(index, 1)
    },

    backgrounds() {
      return BACKGROUNDS
    },

    backgroundPreview(id: string): string {
      return `url("${shippedBackgroundUrl(id)}")`
    },

    formBackgroundUrl(): string {
      if (this.form.backgroundId === 'custom') return this.form.customBackgroundUrl.trim()
      if (this.form.backgroundId) return shippedBackgroundUrl(this.form.backgroundId)
      return ''
    },

    /** Loads the pool image on blur: shows a preview on success, an error on failure. */
    validateImageUrl() {
      const url = this.form.imageUrl.trim()
      if (url && url === this.form.imageUrlValidated) return // unchanged and already loaded
      this.form.imageUrlError = ''
      this.form.imageUrlValidated = ''
      if (!url) return
      const img = new Image()
      img.onload = () => {
        if (this.form.imageUrl.trim() === url) this.form.imageUrlValidated = url
      }
      img.onerror = () => {
        if (this.form.imageUrl.trim() === url) {
          this.form.imageUrlError = 'Could not load an image from that URL — check the address'
        }
      }
      img.src = url
    },

    /**
     * Checks a custom background URL by actually loading it (an <img> GET,
     * same fetch the CSS background will do). Runs when the URL field blurs;
     * only a URL that loaded is live-previewed.
     */
    validateCustomBackground() {
      const url = this.form.customBackgroundUrl.trim()
      if (url && url === this.form.customBgValidated) return // unchanged and already loaded
      this.form.customBgError = ''
      this.form.customBgValidated = ''
      if (!url || this.form.backgroundId !== 'custom') return
      const img = new Image()
      img.onload = () => {
        if (this.form.customBackgroundUrl.trim() === url) this.form.customBgValidated = url
      }
      img.onerror = () => {
        if (this.form.customBackgroundUrl.trim() === url) {
          this.form.customBgError = 'Could not load an image from that URL — check the address'
        }
      }
      img.src = url
    },

    blossomServers() {
      return BLOSSOM_SERVERS
    },

    /** Uploads a file to the chosen Blossom server and fills either the image or the custom-background URL field. */
    async uploadImageFile(target: 'image' | 'background', file: File | undefined) {
      if (!file || !this.session) return
      const busyKey = target === 'image' ? 'imageUploading' : 'bgUploading'
      const errorKey = target === 'image' ? 'imageUrlError' : 'customBgError'
      const openKey = target === 'image' ? 'imageUploadOpen' : 'bgUploadOpen'
      if (this.form[busyKey]) return // a drop while already uploading — ignore, don't race
      const server = BLOSSOM_SERVERS.find((s) => s.id === this.form.blossomServerId) ?? BLOSSOM_SERVERS[0]!
      this.form[busyKey] = true
      this.form[errorKey] = ''
      try {
        const url = await uploadToBlossom(this.session, server, file)
        // The upload endpoint's own 200/201 is stronger confirmation than a
        // follow-up <img> load probe, so the preview is set directly.
        if (target === 'image') {
          this.form.imageUrl = url
          this.form.imageUrlValidated = url
        } else {
          this.form.customBackgroundUrl = url
          this.form.customBgValidated = url
        }
        this.form[openKey] = false // back to the URL-input view, now filled in
      } catch (e) {
        this.form[errorKey] = errMsg(e)
      } finally {
        this.form[busyKey] = false
      }
    },

    /** Live page background while creating: the picked pattern, or a custom URL once it loaded. */
    createBackgroundStyle(): string {
      const url =
        this.form.backgroundId === 'custom' ? this.form.customBgValidated : this.formBackgroundUrl()
      if (!url || this.route !== 'create') return ''
      return backgroundStyle(url)
    },

    async createPool() {
      if (!this.session) return
      this.createError = ''
      this.creating = true
      try {
        const options = this.form.options
          .map((o, i) => ({
            id: String.fromCharCode(97 + i),
            title: o.title.trim(),
            ...(o.description.trim() ? { description: o.description.trim() } : {}),
          }))
          .filter((o) => o.title)
        const deadline = this.form.deadlineLocal
          ? Math.floor(new Date(this.form.deadlineLocal).getTime() / 1000)
          : undefined
        if (deadline !== undefined && deadline <= Math.floor(Date.now() / 1000)) {
          throw new Error('The deadline is in the past')
        }
        const backgroundUrl = this.formBackgroundUrl()
        const content = {
          v: 1 as const,
          title: this.form.title.trim(),
          ...(this.form.description.trim() ? { description: this.form.description.trim() } : {}),
          ...(this.form.imageUrl.trim() ? { imageUrl: this.form.imageUrl.trim() } : {}),
          ...(backgroundUrl ? { backgroundUrl } : {}),
          options,
          adminFeePct: Number(this.form.adminFeePct),
          maxBets: Number(this.form.maxBets),
          maxBetSats: Number(this.form.maxBetSats),
          ...(deadline !== undefined ? { deadline } : {}),
        }
        const relays = mergeRelays(this.form.relaysText.split('\n'), DEFAULT_RELAYS)
        const aesKey = generateAesKey()
        const template = await buildPoolTemplate(content, aesKey)
        const signed = await signEvent(this.session, template)
        const accepted = await publishToRelays(relays, signed)
        const hash = buildShareHash({
          poolId: signed.id,
          adminPubkey: this.session.pubkey,
          relays: accepted,
          aesKey,
        })
        this.resetForm()
        window.location.hash = hash // straight to the pool page
      } catch (e) {
        this.createError = errMsg(e)
      } finally {
        this.creating = false
      }
    },

    // ================= pool loading =================

    teardownPool() {
      this.sub?.close()
      this.sub = null
      if (this.ticker) clearInterval(this.ticker)
      this.ticker = 0
      this.pool = null
      this.poolError = ''
      this.bets = []
      this.seenReceipts = new Set()
      this.actionEvents = []
      this.status = { closed: false, winnerOptionId: null, cancelled: false, paidReceiptIds: new Set() }
      this.comments = []
      this.adminProfile = null
      this.adminParams = null
      this.bet.open = false
      this.payoutModal.open = false
      this.betSession = null
      this.betAnonName = ''
      this.pendingBetOption = ''
      this.pendingBetDraft = null
      this.decryptedAddresses = {}
      this.refreshing = false
    },

    async loadPool() {
      this.poolLoading = true
      this.poolError = ''
      try {
        const ref = parseShareHash(window.location.hash)
        if (!ref) throw new Error('This link is not a valid betting pool link')
        this.poolRef = ref
        const relays = mergeRelays(ref.relays, DEFAULT_RELAYS)
        const event = await fetchEventById(ref.poolId, relays)
        if (!event) throw new Error('Pool not found on its relays — check the link or try again')
        this.pool = await parsePoolEvent(event, ref.aesKey, relays)
        this.subscribePoolEvents()
        this.ticker = setInterval(() => {
          this.nowSec = Math.floor(Date.now() / 1000)
        }, 1000)
        // Runs in the background so the pool renders immediately. Zap
        // receipts that arrive before the admin's provider pubkey is known
        // are safely skipped (see handlePoolEvent), not dropped — this
        // refresh re-fetches and validates them promptly once it's loaded.
        void this.loadAdminSide().then(() => {
          if (this.adminParams) void this.refreshPoolEvents()
        })
      } catch (e) {
        this.poolError = errMsg(e)
      } finally {
        this.poolLoading = false
      }
    },

    async loadAdminSide() {
      if (!this.pool) return
      try {
        this.adminProfile = await fetchProfile(this.pool.adminPubkey, this.pool.relays)
        const address = this.adminProfile.lud16 ?? this.adminProfile.lud06
        if (address) this.adminParams = await fetchPayParams(address)
      } catch {
        // Zapping needs adminParams; retried on demand in submitBet.
      }
    },

    /** Comments and admin actions only count when signed by the admin, so ask the
     * relays for the admin's alone; zap receipts come from the LNURL provider
     * and can't be author-filtered. Shared by the live subscription and the
     * catch-up refresh so both query exactly the same events. */
    poolEventFilters(pool: Pool): Filter[] {
      return [
        { kinds: [KIND_ZAP_RECEIPT], '#e': [pool.id] },
        { kinds: [KIND_ADMIN_ACTION, KIND_COMMENT], authors: [pool.adminPubkey], '#e': [pool.id] },
      ]
    },

    subscribePoolEvents() {
      if (!this.pool) return
      const onevent = (event: Event) => {
        void this.handlePoolEvent(event)
      }
      const subs = this.poolEventFilters(this.pool).map((filter) =>
        relayPool.subscribeMany(this.pool!.relays, filter, { onevent }),
      )
      this.sub = { close: () => subs.forEach((s) => s.close()) }
    },

    refreshing: false,

    /**
     * Re-fetches the pool's events from scratch and restarts the live
     * subscription. Mobile browsers can suspend a backgrounded tab's
     * websocket (e.g. while the user pays an invoice in their wallet app),
     * silently missing events published in the meantime — this catches up.
     * Safe to call repeatedly: handlePoolEvent already dedupes every kind.
     */
    async refreshPoolEvents() {
      if (!this.pool || this.refreshing) return
      this.refreshing = true
      try {
        // Retries a failed/still-missing admin lookup, so a temporary outage
        // in the admin's LNURL server self-heals on the next refresh instead
        // of leaving zap receipts fail-closed (skipped) indefinitely.
        if (!this.adminParams) await this.loadAdminSide()
        const pool = this.pool
        const results = await Promise.all(
          this.poolEventFilters(pool).map((filter) =>
            relayPool.querySync(pool.relays, filter, { maxWait: 6000 }).catch(() => []),
          ),
        )
        for (const events of results) {
          for (const event of events) await this.handlePoolEvent(event)
        }
        // The live subscription's websocket may also be dead after backgrounding.
        this.sub?.close()
        this.subscribePoolEvents()
      } finally {
        this.refreshing = false
      }
    },

    async handlePoolEvent(event: Event) {
      if (!this.pool || !this.poolRef) return
      if (event.kind === KIND_ZAP_RECEIPT) {
        if (this.seenReceipts.has(event.id)) return
        // The admin's LNURL provider pubkey isn't known yet (still loading, or
        // its lookup failed) — fail closed rather than skip the signer check:
        // without it, anyone could self-sign a fake receipt claiming any
        // amount. Don't mark the event seen, so refreshPoolEvents retries it
        // once the provider pubkey is known (see loadAdminSide/loadPool).
        const providerPubkey = this.adminParams?.nostrPubkey
        if (!providerPubkey) return
        this.seenReceipts.add(event.id)
        const bet = await parseZapReceipt(event, {
          poolId: this.pool.id,
          adminPubkey: this.pool.adminPubkey,
          aesKey: this.poolRef.aesKey,
          providerPubkey,
        })
        if (!bet) return
        this.bets.push(bet)
        this.bets.sort((a, b) => a.createdAt - b.createdAt)
        void this.ensureProfiles([bet.bettorPubkey])
        if (this.bet.open && this.bet.state === 'invoice' && bet.requestId === this.bet.requestId) {
          this.bet.state = 'paid'
        }
      } else if (event.kind === KIND_ADMIN_ACTION) {
        if (this.actionEvents.some((e) => e.id === event.id)) return
        this.actionEvents.push(event)
        this.status = await foldAdminActions(this.actionEvents, this.pool, this.poolRef.aesKey)
      } else if (event.kind === KIND_COMMENT) {
        // Only the admin may comment; drop others even if a relay ignores the author filter.
        if (event.pubkey !== this.pool.adminPubkey) return
        if (this.comments.some((c) => c.id === event.id)) return
        const comment = await parseComment(event, this.poolRef.aesKey)
        if (!comment) return
        this.comments.push(comment)
        this.comments.sort((a, b) => a.createdAt - b.createdAt)
        void this.ensureProfiles([comment.authorPubkey])
      }
    },

    async ensureProfiles(pubkeys: string[]) {
      if (!this.pool) return
      const missing = pubkeys.filter((p) => !this.profiles[p])
      if (missing.length === 0) return
      const fetched = await fetchProfiles(missing, this.pool.relays).catch(() => null)
      if (!fetched) return
      for (const [pk, profile] of fetched) this.profiles[pk] = profile
    },

    // ================= pool display helpers =================

    get isAdmin(): boolean {
      return !!this.session && !!this.pool && this.session.pubkey === this.pool.adminPubkey
    },

    get potSats(): number {
      return totalPotSats(this.bets)
    },

    optionTotal(optionId: string): number {
      return totalsByOption(this.bets).get(optionId) ?? 0
    },

    optionBets(optionId: string): Bet[] {
      return this.bets.filter((b) => b.optionId === optionId)
    },

    get deadlinePassed(): boolean {
      const deadline = this.pool?.content.deadline
      return deadline !== undefined && this.nowSec >= deadline
    },

    get maxBetsReached(): boolean {
      return !!this.pool && this.bets.length >= this.pool.content.maxBets
    },

    get bettingOpen(): boolean {
      return !!this.pool && !this.status.closed && !this.deadlinePassed && !this.maxBetsReached
    },

    get blockReason(): string {
      if (!this.pool) return ''
      if (this.status.cancelled) return 'This pool was cancelled — bets are refunded'
      if (this.status.winnerOptionId) return 'This pool has been settled'
      if (this.status.closed) return 'The admin closed betting'
      if (this.deadlinePassed) return 'The betting deadline has passed'
      if (this.maxBetsReached) return `The maximum of ${this.pool.content.maxBets} bets was reached`
      return ''
    },

    get countdown(): string {
      const deadline = this.pool?.content.deadline
      if (deadline === undefined) return ''
      let secs = deadline - this.nowSec
      if (secs <= 0) return 'Betting closed'
      const d = Math.floor(secs / 86400)
      secs -= d * 86400
      const h = Math.floor(secs / 3600)
      secs -= h * 3600
      const m = Math.floor(secs / 60)
      const s = secs - m * 60
      const pad = (n: number) => String(n).padStart(2, '0')
      return d > 0 ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`
    },

    displayName(pubkey: string): string {
      const profile = this.profiles[pubkey]
      if (profile?.name) return profile.name
      if (this.session && pubkey === this.session.pubkey) return this.myProfile?.name ?? 'You'
      return pubkey.slice(0, 8) + '…'
    },

    /** The admin's profile on njump, with the pool's relays as hints. */
    adminNjumpUrl(): string {
      if (!this.pool) return ''
      const nprofile = nip19.nprofileEncode({
        pubkey: this.pool.adminPubkey,
        relays: this.pool.relays.slice(0, 3),
      })
      return `https://njump.me/${nprofile}`
    },

    adminName(): string {
      if (!this.pool) return ''
      return this.adminProfile?.name ?? this.pool.adminPubkey.slice(0, 8) + '…'
    },

    fmtSats(n: number): string {
      return new Intl.NumberFormat('en-US').format(n)
    },

    fmtTime(unix: number): string {
      return new Date(unix * 1000).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    },

    optionTitle(optionId: string): string {
      return this.pool?.content.options.find((o) => o.id === optionId)?.title ?? optionId
    },

    poolBackgroundStyle(): string {
      const url = this.pool?.content.backgroundUrl
      if (!url || !this.disclaimerAccepted) return ''
      return backgroundStyle(url)
    },

    shareLink(): string {
      if (!this.pool || !this.poolRef) return ''
      return `${window.location.origin}${window.location.pathname}${buildShareHash({
        poolId: this.pool.id,
        adminPubkey: this.pool.adminPubkey,
        relays: this.pool.relays,
        aesKey: this.poolRef.aesKey,
      })}`
    },

    async copy(text: string, tag: string) {
      if (await copyToClipboard(text)) {
        this.copied = tag
        setTimeout(() => {
          if (this.copied === tag) this.copied = ''
        }, 2000)
      }
    },

    async sharePool() {
      const link = this.shareLink()
      if (navigator.share) {
        await navigator.share({ title: this.pool?.content.title ?? 'BetWithFriends', url: link }).catch(() => {})
      } else {
        await this.copy(link, 'share')
      }
    },

    // ================= betting =================

    /** The identity used for zapping: the real login, or the throwaway anonymous one. */
    get zapSession(): Session | null {
      return this.session ?? this.betSession
    },

    get zapperName(): string {
      if (this.session) return this.myProfile?.name || npubOf(this.session).slice(0, 12) + '…'
      return this.betAnonName
    },

    clickOption(optionId: string) {
      if (!this.bettingOpen) return
      if (this.session || this.betSession) {
        this.openBetModal(optionId)
        return
      }
      void this.startAnonymousBet(optionId)
    },

    /**
     * No login required to bet: mint a page-scoped anonymous identity (with a
     * published profile so other participants see a name) and continue.
     */
    async startAnonymousBet(optionId: string) {
      this.bet = { ...this.bet, open: true, optionId, state: 'creating', busy: false, error: '' }
      try {
        const session = createEphemeralSession()
        const name = randomAnonName()
        const relays = this.pool?.relays ?? DEFAULT_RELAYS
        const signed = await signEvent(
          session,
          buildProfileTemplate({ name, about: 'Anonymous bettor via BetWithFriends' }),
        )
        await publishToRelays(relays, signed)
        this.betSession = session
        this.betAnonName = name
        this.profiles[session.pubkey] = { pubkey: session.pubkey, name }
        if (this.bet.open) this.openBetModal(optionId)
      } catch (e) {
        this.bet.error = errMsg(e)
      }
    },

    /** From the bet modal's "Zapping as …" line: trade the anonymous identity for a real login. */
    switchToLogin() {
      this.pendingBetOption = this.bet.optionId
      this.pendingBetDraft = { amount: this.bet.amount, rewardAddress: this.bet.rewardAddress.trim() }
      this.bet.open = false
      this.openLogin('bet')
    },

    openBetModal(optionId: string) {
      this.bet = {
        open: true,
        optionId,
        amount: '',
        rewardAddress: this.myProfile?.lud16 || this.lastRewardAddress,
        state: 'form',
        invoice: '',
        qr: '',
        requestId: '',
        busy: false,
        error: '',
      }
    },

    async submitBet() {
      const session = this.zapSession
      if (!session || !this.pool || !this.poolRef) return
      this.bet.error = ''
      const amount = Math.floor(Number(this.bet.amount))
      if (!Number.isFinite(amount) || amount < 1) {
        this.bet.error = 'Enter a bet amount in sats'
        return
      }
      if (amount > this.pool.content.maxBetSats) {
        this.bet.error = `The maximum bet is ${this.fmtSats(this.pool.content.maxBetSats)} sats`
        return
      }
      const address = this.bet.rewardAddress.trim()
      if (!isLightningAddress(address)) {
        this.bet.error = 'Enter the lightning address that should receive your winnings (name@wallet.com)'
        return
      }
      if (address.length > MAX_REWARD_ADDRESS_CHARS) {
        this.bet.error = `That address is too long — up to ${MAX_REWARD_ADDRESS_CHARS} characters`
        return
      }
      this.bet.busy = true
      try {
        if (!this.adminParams) await this.loadAdminSide()
        if (!this.adminParams) throw new Error("Could not reach the admin's lightning wallet — try again")
        // The reward address is readable only by the admin: NIP-44 to their
        // pubkey, NUL-padded to a fixed length so all bet payloads look identical.
        const padded = padRewardAddress(address)
        const encrypted = await nip44EncryptTo(session, this.pool.adminPubkey, padded)
        const rewardAddress = `nip44:${encrypted}`
        const template = await buildZapRequestTemplate({
          poolId: this.pool.id,
          adminPubkey: this.pool.adminPubkey,
          bettorPubkey: session.pubkey,
          amountSats: amount,
          relays: this.pool.relays,
          payload: { optionId: this.bet.optionId, rewardAddress },
          aesKey: this.poolRef.aesKey,
        })
        const signed = await signEvent(session, template)
        const invoice = await requestInvoice(this.adminParams, amount * 1000, JSON.stringify(signed))
        this.lastRewardAddress = address
        this.bet.invoice = invoice
        this.bet.qr = await invoiceQrDataUrl(invoice)
        this.bet.requestId = signed.id
        this.bet.state = 'invoice'
      } catch (e) {
        this.bet.error = errMsg(e)
      } finally {
        this.bet.busy = false
      }
    },

    // ================= admin =================

    async publishAdminAction(action: Parameters<typeof buildAdminActionTemplate>[1]) {
      if (!this.session || !this.pool || !this.poolRef) return
      const template = await buildAdminActionTemplate(this.pool.id, action, this.poolRef.aesKey)
      const signed = await signEvent(this.session, template)
      await publishToRelays(this.pool.relays, signed)
      await this.handlePoolEvent(signed)
    },

    async closeBets() {
      if (!confirm('Close betting now? Friends will no longer be able to place bets.')) return
      this.adminBusy = true
      this.adminError = ''
      try {
        await this.publishAdminAction({ action: 'close' })
      } catch (e) {
        this.adminError = errMsg(e)
      } finally {
        this.adminBusy = false
      }
    },

    async declareWinner() {
      if (!this.winnerPick) return
      if (this.optionTotal(this.winnerPick) === 0) {
        this.adminError = 'Nobody bet on that option — pick an option with bets, or cancel the pool to refund everyone.'
        return
      }
      const title = this.optionTitle(this.winnerPick)
      if (!confirm(`Declare "${title}" as the winning option? Payouts will be computed from this choice.`)) return
      this.adminBusy = true
      this.adminError = ''
      try {
        await this.publishAdminAction({ action: 'winner', optionId: this.winnerPick })
      } catch (e) {
        this.adminError = errMsg(e)
      } finally {
        this.adminBusy = false
      }
    },

    async cancelPool() {
      if (!confirm('Cancel this pool? No option wins — every bettor gets their bets back minus the admin fee.')) return
      this.adminBusy = true
      this.adminError = ''
      try {
        await this.publishAdminAction({ action: 'cancel' })
      } catch (e) {
        this.adminError = errMsg(e)
      } finally {
        this.adminBusy = false
      }
    },

    /** Winner payouts after settling, or per-bet refunds after cancelling. */
    get payouts(): Payout[] {
      if (!this.pool) return []
      const raw = this.status.cancelled
        ? computeRefunds(this.bets, this.pool.content.adminFeePct)
        : this.status.winnerOptionId
          ? computePayouts(this.bets, this.status.winnerOptionId, this.pool.content.adminFeePct)
          : []
      return raw.map((p) => ({
        ...p,
        paid: this.status.paidReceiptIds.has(p.bet.receiptId),
      }))
    },

    get adminFeeSats(): number {
      if (!this.pool) return 0
      const distributed = this.payouts.reduce((s, p) => s + p.amountSats, 0)
      return this.potSats - distributed
    },

    /** Decrypts a bet's reward address — only the admin's key can. */
    async decryptAddressOf(bet: Bet): Promise<string> {
      if (!this.session) throw new Error('Log in as the admin to read reward addresses')
      let address: string
      if (bet.rewardAddress.startsWith('nip44:')) {
        address = await nip44DecryptFrom(this.session, bet.bettorPubkey, bet.rewardAddress.slice('nip44:'.length))
      } else if (bet.rewardAddress.startsWith('plain:')) {
        address = bet.rewardAddress.slice('plain:'.length)
      } else {
        throw new Error('Unrecognized reward address format')
      }
      return unpadRewardAddress(address)
    },

    /** Fills the admin's per-zap address cache; called lazily from the zap rows. */
    async decryptRewardAddress(bet: Bet) {
      if (!this.isAdmin) return
      if (this.decryptedAddresses[bet.receiptId] !== undefined) return
      this.decryptedAddresses[bet.receiptId] = '…'
      try {
        this.decryptedAddresses[bet.receiptId] = await this.decryptAddressOf(bet)
      } catch {
        this.decryptedAddresses[bet.receiptId] = '(cannot decrypt)'
      }
    },

    async openPayout(payout: Payout) {
      this.payoutModal = { open: true, payout, address: '', invoice: '', qr: '', busy: true, error: '' }
      try {
        const address = await this.decryptAddressOf(payout.bet)
        this.payoutModal.address = address
        const params = await fetchPayParams(address)
        const invoice = await requestInvoice(params, payout.amountSats * 1000)
        this.payoutModal.invoice = invoice
        this.payoutModal.qr = await invoiceQrDataUrl(invoice)
      } catch (e) {
        this.payoutModal.error = errMsg(e)
      } finally {
        this.payoutModal.busy = false
      }
    },

    async togglePaid(payout: Payout) {
      this.adminError = ''
      try {
        await this.publishAdminAction({
          action: payout.paid ? 'unpaid' : 'paid',
          receiptId: payout.bet.receiptId,
        })
      } catch (e) {
        this.adminError = errMsg(e)
      }
    },

    // ================= comments =================

    async postComment() {
      if (!this.isAdmin || !this.session || !this.pool || !this.poolRef) return
      const text = this.commentText.trim()
      if (!text) return
      this.postingComment = true
      try {
        const template = await buildCommentTemplate(this.pool.id, text, this.poolRef.aesKey)
        const signed = await signEvent(this.session, template)
        await publishToRelays(this.pool.relays, signed)
        this.commentText = ''
        await this.handlePoolEvent(signed)
      } catch (e) {
        this.adminError = errMsg(e)
      } finally {
        this.postingComment = false
      }
    },
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Page background with a dark overlay baked in, so light text stays readable
 * on any image. Rendered on the fixed .page-bg layer (see style.css) rather
 * than via background-attachment: fixed, which resizes visibly as a mobile
 * browser's address bar collapses mid-scroll.
 */
function backgroundStyle(url: string): string {
  return (
    `background-image: linear-gradient(rgba(8, 10, 16, 0.45), rgba(8, 10, 16, 0.45)), url("${url.replaceAll('"', '%22')}"); ` +
    'background-size: cover; background-position: center;'
  )
}
