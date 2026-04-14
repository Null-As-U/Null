(function () {
    'use strict';

    // ============================================================================
    // CONFIGURATION & CONSTANTS
    // ============================================================================

    const CONFIG = {
        LOG_MAX_ENTRIES: 5000,
        RETRY_MAX_ATTEMPTS: 3,
        RETRY_BACKOFF_MS: 1000,
        DEFAULT_INTERVAL_SECONDS: 30,
        MIN_INTERVAL_SECONDS: 15, // raised from 5 — polling faster than 15s causes 429s
        MAX_INTERVAL_SECONDS: 60,
        TRACE_BACK_COMMENT_LIMIT: 50,
        CAREEM_CARE_ID: '34980896869267'
    };

    const MAX_ROUTING_COUNT = 1;  // block on 2nd route attempt

    const GROUP_IDS = {
        CARE: 20705088,
        HALA_RIDES: 360003368393,
        MOROCCO: 360011852054,       // FIX: unified name (was CASABLANCA / HQ_MOROCCO)
        EGYPT: 360000017428,
        BIKE_DISPUTE: 360007090594,
        CARE_ESCALATIONS: 22683490344851
    };

    // PQMS User Database (OPS ID -> Full Name)
    const PQMS_USERS = {
        '32951': 'Bader Alzoubi',
        '48461': 'Mohammed Karout',
        '37862': 'Husam Ahmad Ibrahim Alnajy',
        '51049': 'Zaid Mohammad Hussein Banihani',
    };

    // Zendesk User ID -> PQMS OPS ID mapping
    const ZENDESK_TO_PQMS_USER = {
        '27876176449939': '32951',
        '45789835263123': '48461',
        '33072163651987': '37862',
        '46847870144659': '51049',
    };

    const TARGET_VIEWS = [
        'SSOC - Open - Urgent',
        'SSOC - GCC & EM Open',
        'SSOC - Egypt Urgent',
        'SSOC - Egypt Open',
        'SSOC - Pending - Urgent',
        'SSOC - GCC & EM Pending',
        'SSOC - Egypt Pending',
        'SSOC_JOD_from ZD only'
    ];

    // Subject keywords -> Care Escalations routing
    // BUG-09 FIX: Use word-boundary regex to prevent false positives from generic substrings.
    // Subjects starting with negative prefixes ("No ", "Re:", "Fwd:", "Fw:") are excluded.
    const CARE_ESCALATION_SUBJECTS = [
        'escalation', 'complaint', 'urgent complaint', 'legal threat',
        'media threat', 'social media threat', 'safety concern', 'physical harm',
        'assault', 'sexual harassment', 'data breach', 'gdpr', 'regulatory',
        'litigation', 'police report', 'court order'
    ];
    const CARE_ESCALATION_NEGATIVE_PREFIXES = [/^no\s+/i, /^re:/i, /^fwd:/i, /^fw:/i];
    const CARE_ESCALATION_REGEXES = CARE_ESCALATION_SUBJECTS.map(k => {
        const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return { keyword: k, rx: new RegExp(`\\b${escaped}\\b`, 'i') };
    });
    function matchesCareEscalationSubject(subject) {
        if (!subject) return null;
        if (CARE_ESCALATION_NEGATIVE_PREFIXES.some(rx => rx.test(subject.trim()))) return null;
        return CARE_ESCALATION_REGEXES.find(({ rx }) => rx.test(subject))?.keyword || null;
    }

    // ============================================================================
    // BUSINESS RULES & TRIGGER PHRASES
    // ============================================================================

    class RUMIRules {
        static PENDING_TRIGGERS = [
            "directed this matter to the most appropriate support team",
            "escalated this matter to a specialized support team",
            "escalated this matter to a specialised support team",
            "escalated this issue to a dedicated support team",
            "escalated this to a specialized support team",
            "escalated this to a specialised support team",
            "have escalated your issue to a specialized team to review this further",
            "a member of our team will be in touch with you shortly",
            "we've forwarded this issue to a specialized support team",
            "we have forwarded this to a dedicated support team",
            "we're going to escalate your issue to our team that can investigate further",
            "and will provide you with an update as soon as possible",
            "in order to best assist you, we need to bring in another team",
            "you will receive a response as soon as possible",
            "لقد قمنا بتصعيد هذا الأمر إلى الفريق المختص",
            "لقد قمنا بتصعيد هذه المشكلة إلى فريق دعم",
            "لقد قمنا بتصعيد الأمر إلى فريق دعم متخصص",
            "فريق دعم متخصص سيتواصل معك في أقرب وقت ممكن",
            "لقد قمنا بتحويل ملاحظتك إلى الفريق المختص لمتابعتها واتخاذ اللازم",
            "لقد قمنا بتصعيد هذا الأمر إلى فريق دعم متخصص",
            "بمجرد حصولنا على تحديث سنتواصل معك",
            "لقد حاولنا التواصل معك",
            "لقد أردنا الاتصال بك هاتفيا للاطمئنان على سلامتك",
            "we want you to provide us with more information about what happened",
            "if you feel additional information could be helpful",
            "this contact thread will say \"waiting for your reply",
            "but there is nothing else needed from you right now",
            "any additional information would be beneficial to our investigation",
            "keep an eye out for your reply",
            "if you feel additional information could be helpful, please reply to this message",
            "We tried to call you a few moments ago but, unfortunately",
            "in order to be able to further investigate the issue",
            "provide us with more details about what happened",
            "مزيد من التفاصيل عن ما حدث معك أثناء الرحلة",
            "أي تفاصيل إضافية ستساعدنا",
            "المزيد من المعلومات قد",
            "أي معلومات إضافية قد تكون مفيدة",
            "سيتم التواصل في الوقت اللذي تم تحديده",
            "awaiting your reply",
            "waiting for your reply",
            "waiting for your kind response",
            "will be waiting for your reply",
            "keep a keen eye out for your reply",
            "keeping an eye out for your reply",
            "awaiting your response",
            "look out for your reply",
            "we look forward to hearing from you",
            "في انتظار ردك",
            "ف انتظار ردك",
            "ننتظر ردك",
            "في انتظار الرد",
            "سنكون بانتظار ردك",
            "emea urgent triage team zzzdut",
            "no urgent safety concern found",
            "please re-escalate if urgent concerns are confirmed",
            "https://blissnxt.uberinternal.com",
            "https://uber.lighthouse-cloud.com",
            "https://apps.mypurecloud.ie",
            "https://jira.uberinternal.com",
            "call attempt",
            "first call",
            "second call",
            "third call",
            "1st call",
            "2nd call",
            "3rd call",
            "more info",
            "#safety",
            "[rumi] careem escalation",
            "[Global Safety] Taxonomy | Categories and Definitions",
            "More Info needed",
            "No IRT concern found",
        ];

        static SOLVED_TRIGGERS = [
            "be following up with the driver and taking the appropriate actions",
            "be following up with your driver in order to take the appropriate actions",
            "be taking the appropriate actions",
            "be taking the appropriate action",
            "be taking any necessary internal actions",
            "be following up with the driver involved",
            "we have taken the necessary internal actions",
            "You should never be made to feel uncomfortable during a trip using Careem Rides",
            "already taken the appropriate action internally",
            "already taken the appropriate actions internally",
            "we have already taken all the appropriate actions internally",
            "already taken all the necessary internal actions",
            "started taking the appropriate internal actions",
            "these are the actions we have taken",
            "please note that GIG will follow up regarding the insurance within 2 business days",
            "Please note that GIG will contact you within the next 2 business days",
            "we have followed up with the partner-driver immediately",
            "we are unable to specify any internal action taken with individual users of the application",
            "happy to hear the issue has been resolved",
            "our system provided this response based on your issue",
            "if you have any other concerns, please don't hesitate to contact us",
            "وسوف يتم التواصل معك هناك",
            "نريد أن نحتفظ برسائلنا مُوحدة في محادثة واحدة",
            "وقد اتخذنا بالفعل الإجراء المناسب داخليا",
            "وسنتخذ الإجراءات الداخلية",
            "وسوف نقوم بمتابعة التحقيق واتخاذ الإجراءات",
            "وسوف نتخذ الإجراءات المناسبة",
            "سنتابع الأمر مع السائق من أجل اتخاذ الإجراءات المناسبة",
            "وسنتابع الأمر مع الشريك السائق المعني",
            "وقد قمنا بالفعل باتخاذ الإجراءات المناسبة",
            "وسنتابع الأمر مع السائق، لاتخاذ الإجراءات الداخلية المناسبة",
            "سنتابع الأمر مع الشريك السائق ونتخذ الإجراءات الملائمة",
            "وسنتابع الأمر مع الشريك السائق ونتّخذ الإجراءات المناسبة",
            "وسنتخذ الإجراءات الداخلية الملائمة بحق السائق المتورط في الأمر",
            "نعلم أن الأمر غير متعلق بالمال",
            "إننا حريصون على عدم تعرضك للمضايقة",
            "إذا كان لديك استفسار يخص إحدى الرحلات فبرجاء إرسال استفسارك في تقرير منفصل على الرحلة المعنية وسوف يتم الرد عليك من قبل الفريق المختص في أقرب وقت",
            "نرجو عدم التردد في التواصل معنا في حال كان هناك استفسار آخر بخصوص هذا الأمر",
            "to try to ensure the experience you describe can't happen again",
            "we have also made some changes in the application to reduce the chance of you being paired with this partner driver in the future",
            "we want everyone, both drivers and riders, to have a safe, respectful, and comfortable experience as stated in our careem rides community guidelines",
            "we also want to make you aware of it as it is something we take very seriously here at",
            "we can confirm that this trip isn't eligible for a price adjustment",
            "We want to be able to streamline our communications to one source",
            "direct any response to the main message and we will continue to correspond with you there",
            "قد أجرينا أيضا بعض التغييرات في التطبيق للتقليل من فرص",
            "إذا تمت مطابقتك مرة أخرى، يرجى إلغاء الرحلة والتواصل معنا من خلال التطبيق",
            "لذلك قمنا بإعادة قيمة أجرة هذه الرحلة",
            "it looks like you've already raised a similar concern for this trip that our support team has resolved",
            "will be handled by one of our specialized teams through another message soon",
            "our specialized teams through another message soon",
            "already directed your concern to the relevant team and they will get back to you as soon as possible",
            "وسوف يقوم أحد أعضاء الفريق المختص لدينا بالتواصل معك من خلال رسالة أخرى بخصوص استفسارك في أقرب وقت ممكن",
            "سوف يتم الرد على إستفسارك في رسالة أخرى من الفريق المختص",
            "ومن ثم، سنغلق تذكرة الدعم الحالية لتسهيل التواصل وتجنب أي التباس",
            "يمكننا الرد على أي استفسارات حول هذا الأمر في أي وقت",
            "لنمنح الركاب تجربة خالية من المتاعب حتى يتمكنوا من إجراء مشوار في أقرب وقت ممكن",
            "ويمكننا ملاحظة أنك قد تواصلت معنا بشأنها من قبل",
            "نحرص دائما على توفير تجربة آمنة ومريحة تتسم بالاحترام للركاب والسائقين",
            "فسوف يتم الرد عليك برسالة أخرى من الفريق المختص",
            "إن سلامة جميع المستخدمين من أهم أولوياتنا",
            "يتم مراجعة الملاحظات وإتخاذ أي إجراءات داخلية ضرورية",
            "بالتواصل معك بخصوص استفسارك من خلال رسالة أخرى",
            "وقام أحد أعضاء الفريق المختص لدينا بالتواصل معك من خلال رسالة أخرى",
            "ويسعدنا معرفة أنه قد تم حل المشكلة",
            "سوف يتم الرد على إستفسارك في رسالة أخرى من الفريق المختص",
            "من خلال بوابة الاستجابة للسلامة العامة المخصصة",
            "نود إعلامك أنه قد تم بالفعل اتخاذ الإجراءات اللازمة حول هذا الأمر",
            "lert@uber.com",
            "nrn"
        ];

        static CARE_ROUTING_PHRASES = [
            "#notsafety",
            "careem actions required on rider",
            "careem actions required for rider",
            "action required by careem",
            "actions required by careem",
            "ask the rider",
            "inform the rider",
            "captain asks for extra money is no longer a safety case",
            "not safety related",
            "kindly share the wusool"
        ];

        static ESCALATED_BUT_NO_RESPONSE = "i'm truly sorry to hear about what happened during your trip. to assist you better, our team will contact you shortly to get more details about the incident";
    }

    // ============================================================================
    // COMMENT PROCESSING & NORMALIZATION
    // ============================================================================

    class RUMICommentProcessor {
        static htmlToPlainText(htmlBody) {
            if (!htmlBody) return '';
            let text = htmlBody;
            text = text.replace(/\\u003C/g, '<').replace(/\\u003E/g, '>');
            text = text.replace(/<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>/gi, '$2 ($1)');
            text = text.replace(/<\/?(p|div|br)[^>]*>/gi, '\n');
            text = text.replace(/<[^>]+>/g, '');
            text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
            return text.replace(/\s+/g, ' ').trim();
        }

        static normalizeForMatching(htmlBody) {
            const diacritics = /[\u064B-\u0652]/g;
            return this.htmlToPlainText(htmlBody).toLowerCase().replace(diacritics, '');
        }

        static matchesTrigger(normalizedComment, triggerPhrase) {
            return normalizedComment.includes(triggerPhrase.toLowerCase());
        }

        static matchesAnyTrigger(normalizedComment, triggerPhrases) {
            return triggerPhrases.some(phrase => this.matchesTrigger(normalizedComment, phrase));
        }
    }

    // ============================================================================
    // IDEMPOTENCY TRACKING
    // ============================================================================

    class RUMIIdempotency {
        static getProcessedData(ticketId) {
            return RUMIStorage.get(`processed_${ticketId}`, null);
        }

        static setProcessedData(ticketId, data) {
            RUMIStorage.set(`processed_${ticketId}`, {
                lastProcessedCommentId: data.commentId,
                actionType: data.actionType,
                timesTriggered: (this.getProcessedData(ticketId)?.timesTriggered || 0) + 1,
                lastProcessedAtUTC: new Date().toISOString()
            });
        }

        static clearProcessedData(ticketId) {
            RUMIStorage.remove(`processed_${ticketId}`);
        }

        static shouldProcess(ticketId, latestCommentId, actionType, currentGroupId, targetGroupId) {
            const processed = this.getProcessedData(ticketId);
            if (!processed) return true;
            // BUG-01 FIX: For routing actions, only clear & re-process if the ticket is NOT
            // already in the target group. If it is already there, return false to prevent loops.
            if (['care', 'hala', 'morocco', 'bikeDispute', 'egypt', 'careEscalations'].includes(actionType)) {
                if (targetGroupId && currentGroupId && String(currentGroupId) === String(targetGroupId)) {
                    return false;
                }
                this.clearProcessedData(ticketId);
                return true;
            }
            if (['pending', 'solved'].includes(actionType)) {
                return processed.lastProcessedCommentId !== latestCommentId;
            }
            return true;
        }
    }

    // ============================================================================
    // TICKET PROCESSING ENGINE
    // ============================================================================

    class RUMIProcessor {
        static isDryRun = false;
        static currentUserId = null;
        static _userRoleCache = new Map(); // BUG-05 FIX: per-pass cache, cleared each processTicketWithData call

        static async init() {
            try {
                const userData = await RUMIAPIManager.get('/api/v2/users/me.json');
                this.currentUserId = userData.user.id;
                RUMILogger.info('PROCESSOR', 'Initialized with user ID', { userId: this.currentUserId });
            } catch (error) {
                RUMILogger.error('PROCESSOR', 'Failed to fetch current user', { error: error.message });
            }
        }

        static clearCachedUserId() {
            this.currentUserId = null;
        }

        static async ensureCurrentUserId() {
            if (!this.currentUserId) await this.init();
            return this.currentUserId;
        }

        // ── Main entry point (fetch-then-process) ──────────────────────────────
        static async processTicket(ticketId, viewName = null) {
            try {
                const ticket = await RUMIAPIManager.get(`/api/v2/tickets/${ticketId}.json`);
                if (ticket.ticket.status === 'closed') return { action: 'skipped', reason: 'ticket_closed' };
                // BUG-CMTPAG FIX: use paginated fetchAllComments instead of single-page GET
                const comments = await RUMIAPIManager.fetchAllComments(ticketId);
                return await this.processTicketWithData(
                    ticketId, ticket.ticket, comments || [], viewName, false
                );
            } catch (error) {
                RUMILogger.error('PROCESSOR', 'Failed to process ticket', { ticketId, error: error.message });
                return { action: 'error', error: error.message };
            }
        }

        // ── Core processor (data already fetched) ──────────────────────────────
        static async processTicketWithData(ticketId, ticketData, commentsList, viewName = null, isManual = false) {
            try {
                const isDryRunMode = isManual ? RUMIStorage.getManualProcessingSettings().dryRunMode : this.isDryRun;

                // ── Blocked pin check ──
                if (RUMIPinManager.checkBlockedPin(ticketId)) {
                    const previousGroupName = await this.fetchAndCacheGroupName(ticketData.group_id);
                    const data = {
                        ticketId, subject: ticketData.subject || 'N/A', viewName: viewName || 'Manual',
                        action: 'skipped', trigger: 'Blocked Pin',
                        previousStatus: ticketData.status, newStatus: ticketData.status,
                        previousGroupId: ticketData.group_id, previousGroupName,
                        newGroupId: ticketData.group_id, newGroupName: previousGroupName,
                        previousAssigneeId: ticketData.assignee_id, newAssigneeId: ticketData.assignee_id,
                        dryRun: isDryRunMode, alreadyCorrect: false,
                        note: 'Ticket is pinned as blocked', isBlockedPin: true
                    };
                    this._storeTicket(data, isManual);
                    return { action: 'skipped', reason: 'blocked_pin' };
                }

                // ── Care routing pin check ──
                const careRoutingResult = await RUMIPinManager.checkCareRoutingPin(ticketId, ticketData, commentsList);
                if (careRoutingResult) {
                    if (careRoutingResult.action === 'care') {
                        const payload = careRoutingResult.payload;
                        const previousGroupName = await this.fetchAndCacheGroupName(ticketData.group_id);
                        const newGroupId = payload?.ticket?.group_id || ticketData.group_id;
                        const newStatus = payload?.ticket?.status || ticketData.status;
                        const newGroupName = await this.fetchAndCacheGroupName(newGroupId);
                        if (!isDryRunMode) await this.applyChanges(ticketId, payload);
                        const carePinData = {
                            ticketId, subject: ticketData.subject || 'N/A', viewName: viewName || 'Manual',
                            action: 'care', trigger: 'Pinned Ticket',
                            previousStatus: ticketData.status, newStatus,
                            previousGroupId: ticketData.group_id, previousGroupName,
                            newGroupId, newGroupName,
                            previousAssigneeId: ticketData.assignee_id, newAssigneeId: payload?.ticket?.assignee_id || ticketData.assignee_id,
                            dryRun: isDryRunMode, alreadyCorrect: false, note: null
                        };
                        this._storeTicket(carePinData, isManual);
                        this._updateStats('care', isManual);

                        // Important: this branch bypasses the normal "Action applied: ..." log,
                        // so we must log the ticket action here for the Logs tab.
                        if (isDryRunMode) {
                            RUMILogger.info('PIN', `[DRY RUN] Would apply Care routing for ticket ${ticketId}`, { ticketId, newGroupId, newStatus });
                        } else {
                            RUMILogger.info('PIN', `Care routing applied for ticket ${ticketId}`, { ticketId, previousGroupId: ticketData.group_id, newGroupId, previousStatus: ticketData.status, newStatus });
                        }
                    }
                    return careRoutingResult;
                }

                if (ticketData.status === 'closed') return { action: 'skipped', reason: 'closed' };
                if (commentsList.length === 0) return { action: 'skipped', reason: 'no_comments' };

                const result = await this.evaluateRules(ticketData, commentsList, isManual, viewName);

                if (result.action === 'none') {
                    // BUG-DRVIS FIX: also store 'none' tickets in dry-run mode for full visibility
                    if (isManual || isDryRunMode) {
                        const previousGroupName = await this.fetchAndCacheGroupName(ticketData.group_id);
                        this._storeTicket({
                            ticketId, subject: ticketData.subject || 'N/A', viewName: viewName || 'Manual',
                            action: 'none', trigger: 'No matching rule',
                            previousStatus: ticketData.status, newStatus: ticketData.status,
                            previousGroupId: ticketData.group_id, previousGroupName,
                            newGroupId: ticketData.group_id, newGroupName: previousGroupName,
                            previousAssigneeId: ticketData.assignee_id, newAssigneeId: ticketData.assignee_id,
                            dryRun: isDryRunMode, alreadyCorrect: false,
                            note: 'Ticket does not match any business rules'
                        }, true);
                    }
                    return result;
                }

                const latestCommentId = commentsList[commentsList.length - 1].id;
                const _currentGroupId = ticketData.group_id;
                const _targetGroupId = result.payload?.ticket?.group_id;
                if (!RUMIIdempotency.shouldProcess(ticketId, latestCommentId, result.action, _currentGroupId, _targetGroupId)) {
                    return { action: 'skipped', reason: 'idempotency' };
                }

                const originalStatus = ticketData.status;
                const originalGroupId = ticketData.group_id;
                const targetStatus = result.payload?.ticket?.status;
                const targetGroupId = result.payload?.ticket?.group_id;
                // BUG-03 FIX: Use AND logic — both must already match; OR caused group-change tickets to be silently skipped
                const alreadyCorrect = (!targetStatus || targetStatus === originalStatus) &&
                    (!targetGroupId || targetGroupId === originalGroupId);

                const previousGroupName = await this.fetchAndCacheGroupName(originalGroupId);
                const newGroupId = result.payload?.ticket?.group_id || originalGroupId;
                const newGroupName = await this.fetchAndCacheGroupName(newGroupId);

                const processedData = {
                    ticketId, subject: ticketData.subject || 'N/A', viewName: viewName || 'Manual',
                    action: result.action, trigger: result.trigger || 'N/A',
                    previousStatus: originalStatus, newStatus: result.payload?.ticket?.status || originalStatus,
                    previousGroupId: originalGroupId, previousGroupName,
                    newGroupId, newGroupName,
                    previousAssigneeId: ticketData.assignee_id,
                    newAssigneeId: result.payload?.ticket?.assignee_id || ticketData.assignee_id,
                    dryRun: isDryRunMode, alreadyCorrect,
                    note: alreadyCorrect
                        ? `Ticket should be set to ${targetStatus || newGroupName}, but it won't because it is already ${originalStatus || previousGroupName}`
                        : null
                };

                const ROUTING_ACTIONS = ['care','hala','morocco','egypt','bikeDispute','careEscalations'];
                if (!isDryRunMode) {
                if (ROUTING_ACTIONS.includes(result.action)) {
                    const currentCount = RUMIStorage.getRoutingCount(String(ticketId));
                    if (currentCount >= MAX_ROUTING_COUNT) {
                        // Ticket has already been routed MAX_ROUTING_COUNT times — block it
                        RUMILogger.warn('PROCESSOR',
                            `[Double-Route Block] Ticket ${ticketId} routed ${currentCount} times — auto-pinning as blocked`,
                            { ticketId, routingCount: currentCount, blockedAction: result.action });

                        // Auto-pin as Block Processing (same as manual pin)
                        if (!RUMIStorage.getPinnedBlocked().some(p => p.ticketId === String(ticketId))) {
                            RUMIStorage.addPinnedBlocked(String(ticketId), 'double_route');
                            RUMIUI.renderPinnedList();
                            RUMIUI.showToast(
                                `Ticket ${ticketId} auto-blocked — routed ${currentCount}× already`,
                                'warning');
                        }

                        // Store a record in the processed tickets table so it's visible
                        const prevGroupName = await this.fetchAndCacheGroupName(ticketData.group_id);
                        this._storeTicket({
                            ticketId: String(ticketId),
                            subject: ticketData.subject || 'N/A',
                            viewName: viewName || 'Auto',
                            action: 'skipped',
                            trigger: `Double-Route Block (routed ${currentCount}× — max is ${MAX_ROUTING_COUNT})`,
                            previousStatus: ticketData.status,
                            newStatus: ticketData.status,
                            previousGroupId: ticketData.group_id,
                            previousGroupName: prevGroupName,
                            newGroupId: ticketData.group_id,
                            newGroupName: prevGroupName,
                            previousAssigneeId: ticketData.assignee_id,
                            newAssigneeId: ticketData.assignee_id,
                            dryRun: isDryRunMode,
                            alreadyCorrect: false,
                            note: `Blocked: ticket was already routed ${currentCount} time(s). Auto-pinned for manual review.`,
                            isDoubleRouteBlock: true
                        }, isManual);

                        return { action: 'skipped', reason: 'double_route_block' };
                    }
                    // Not yet at the limit — increment the counter
                    const newCount = RUMIStorage.incrementRoutingCount(String(ticketId));
                    RUMILogger.info('PROCESSOR',
                        `[Routing Count] Ticket ${ticketId} routed ${newCount}/${MAX_ROUTING_COUNT} times`,
                        { ticketId, routingCount: newCount, action: result.action });
                }
                } // end !isDryRunMode routing counter guard

                if (!isDryRunMode && !alreadyCorrect) {
                    await this.applyChanges(ticketId, result.payload);
                    RUMILogger.info('PROCESSOR', `Action applied: ${result.action}`, { ticketId, trigger: result.trigger?.substring(0, 80) });

                    // BUG-01 FIX: Record all successful actions (including routing) in idempotency store
                    RUMIIdempotency.setProcessedData(ticketId, { commentId: latestCommentId, actionType: result.action });

                    // PQMS auto-submission
                    if (result.action === 'solved') {
                        RUMIPQMS.submitSolvedTicket(ticketId, ticketData.subject, previousGroupName, isManual);
                    } else if (result.action === 'pending') {
                        RUMIPQMS.submitPendingTicket(ticketId, ticketData.subject, previousGroupName, isManual);
                    }
                } else if (!isDryRunMode && alreadyCorrect) {
                    RUMIIdempotency.setProcessedData(ticketId, { commentId: latestCommentId, actionType: result.action });
                } else if (isDryRunMode) {
                    RUMILogger.info('PROCESSOR', `[DRY RUN] Would apply: ${result.action}`, { ticketId });
                    // BUG-DRYIDEM FIX: persist idempotency in dry-run so tickets aren't re-processed every poll
                    RUMIIdempotency.setProcessedData(ticketId, { commentId: latestCommentId, actionType: result.action });
                }

                if (!alreadyCorrect) {
                    this._storeTicket(processedData, isManual);
                    this._updateStats(result.action, isManual);
                } else {
                    RUMILogger.debug('PROCESSOR', `Skipped — ticket already in target state`, { ticketId, status: originalStatus });
                }
                return { ...result, ticketData: processedData };

            } catch (error) {
                RUMILogger.error('PROCESSOR', 'Failed to process ticket', { ticketId, error: error.message });
                return { action: 'error', error: error.message };
            }
        }

        // ── Storage helpers ────────────────────────────────────────────────────
        static _storeTicket(data, isManual) {
            if (isManual) RUMIStorage.addManualProcessedTicket(data);
            else RUMIStorage.addProcessedTicket(data);
        }

        static _updateStats(action, isManual) {
            if (isManual) RUMIStorage.updateManualProcessingStats(action);
            else RUMIStorage.updateProcessingStats(action);
        }

        // ── Rule evaluation ────────────────────────────────────────────────────
        static async evaluateRules(ticket, comments, isManual = false, viewName = null) {
            const settings = isManual ? RUMIStorage.getManualSettings() : RUMIStorage.getAutomaticSettings();

            // FIX-09: pre-compute enabled trigger arrays once per evaluation (not per-comment)
            const enabledTriggers = {
                pending: RUMIRules.PENDING_TRIGGERS.filter(p => settings.triggerPhrases.pending[p] !== false),
                solved:  RUMIRules.SOLVED_TRIGGERS.filter(p => settings.triggerPhrases.solved[p] !== false),
                care:    RUMIRules.CARE_ROUTING_PHRASES.filter(p => settings.triggerPhrases.careRouting[p] !== false)
            };

            // 1. Routing rules (highest priority)
            const routingResult = await this.evaluateRoutingRules(ticket, comments, settings, enabledTriggers);
            if (routingResult.action !== 'none') return routingResult;

            // 2. Safety gate + required phrases — single combined scan (FIX-10)
            const { hasSafetyGate, hasRequired } = this.checkSafetyAndRequiredPhrases(comments);

            if (!hasSafetyGate) {
                RUMILogger.debug('PROCESSOR', 'Safety Gate: CareemInboundPhone not found', { ticketId: ticket.id });
                return { action: 'none' };
            }

            const hasRequiredPhrases = hasRequired;

            // 3. Escalation response (customer replied after escalation phrase)
            const escalationResult = await this.evaluateEscalationResponseRules(ticket, comments, settings, viewName, hasRequiredPhrases, enabledTriggers);
            if (escalationResult.action !== 'none') return escalationResult;

            // 4. Pending rules
            const pendingResult = await this.evaluatePendingRules(ticket, comments, settings, viewName, hasRequiredPhrases, enabledTriggers);
            if (pendingResult.action !== 'none') return pendingResult;

            // 5. Solved rules
            const solvedResult = await this.evaluateSolvedRules(ticket, comments, settings, hasRequiredPhrases, enabledTriggers);
            if (solvedResult.action !== 'none') return solvedResult;

            // 6. Fallback status rules (customer reply / agent public comment)
            const statusResult = await this.evaluateStatusRules(ticket, comments, settings, viewName, enabledTriggers);
            if (statusResult.action !== 'none') return statusResult;

            return { action: 'none' };
        }

        // ── Routing rules ──────────────────────────────────────────────────────
        static async evaluateRoutingRules(ticket, comments, settings, enabledTriggers = null) {

            // PRIORITY 0 — Care Escalations (subject keyword)
            // BUG-07 FIX: guard with settings.actionTypes.careEscalations toggle (was unconditional)
            // BUG-09 FIX: use word-boundary regex helper instead of plain substring match
            if (settings.actionTypes.careEscalations && ticket.subject) {
                const matchedSubject = matchesCareEscalationSubject(ticket.subject);
                if (matchedSubject) {
                    if (ticket.group_id === GROUP_IDS.CARE_ESCALATIONS) {
                        return { action: 'none' };
                    }
                    const payload = { ticket: { group_id: GROUP_IDS.CARE_ESCALATIONS } };
                    if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                    RUMILogger.info('ROUTING', 'Care Escalations subject match', { ticketId: ticket.id, keyword: matchedSubject });
                    return { action: 'careEscalations', trigger: `Subject keyword: "${matchedSubject}"`, payload };
                }
            }

            // Bike Dispute
            if (settings.actionTypes.bikeDispute && ticket.subject?.toLowerCase().includes('bike dispute')) {
                if (ticket.group_id === GROUP_IDS.BIKE_DISPUTE) return { action: 'none' };
                const payload = { ticket: { group_id: GROUP_IDS.BIKE_DISPUTE } };
                if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                RUMILogger.info('ROUTING', 'Bike Dispute match', { ticketId: ticket.id });
                return { action: 'bikeDispute', trigger: 'Subject: Bike Dispute', payload };
            }

            // Hala Rides
            if (settings.actionTypes.rta && ticket.tags?.includes('ghc_provider_hala-rides')) {
                if (ticket.group_id === GROUP_IDS.HALA_RIDES) return { action: 'none' };
                const payload = { ticket: { group_id: GROUP_IDS.HALA_RIDES } };
                if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                RUMILogger.info('ROUTING', 'Hala Rides match', { ticketId: ticket.id });
                return { action: 'hala', trigger: 'Tag: ghc_provider_hala-rides', payload };
            }

            // Egypt — FIX: guard prevents loop
            const egyptCities = ['cairo', 'giza', 'alexandria', 'mansoura', 'tanta', 'zagazig', 'hurghada'];
            const tagsLower = ticket.tags ? ticket.tags.map(t => t.toLowerCase()) : [];
            const hasEgyptCity = tagsLower.some(t => egyptCities.includes(t));
            const isEgypt = tagsLower.some(t =>
                t === 'egypt' || t === 'tc_egypt' || t === '__dc_country___egypt__' ||
                t === 'rumi_egy_ticket' || t.includes('alexandria') ||
                t.includes('_egypt_') || t.includes('city_alexandria') || t.includes('__city_alexandria__')
            );
            const hasEgyptCityField = ticket.custom_fields?.some(f =>
                f.value && typeof f.value === 'string' && egyptCities.includes(f.value.toLowerCase().trim())
            );

            if (settings.actionTypes.egypt && (hasEgyptCity || isEgypt || hasEgyptCityField)) {
                if (ticket.group_id === GROUP_IDS.EGYPT) return { action: 'none' };
                const payload = { ticket: { group_id: GROUP_IDS.EGYPT } };
                if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                RUMILogger.info('ROUTING', 'Egypt routing match', { ticketId: ticket.id });
                return { action: 'egypt', trigger: 'Egypt City/Tag Routing', payload };
            }

            // Morocco (FIX: unified from casablanca — action key is now 'morocco')
            const moroccoCities = ['casablanca', 'rabat', 'tangier'];
            const hasMoroccoCity = ticket.tags?.some(t => moroccoCities.includes(t.toLowerCase()));
            const isMorocco = ticket.tags && (
                ticket.tags.includes('morocco') || ticket.tags.includes('tc_morocco') ||
                ticket.tags.includes('__dc_country___morocco__')
            );
            const hasMoroccoCityField = ticket.custom_fields?.some(f =>
                f.value && typeof f.value === 'string' && moroccoCities.includes(f.value.toLowerCase())
            );

            if (settings.actionTypes.morocco && (hasMoroccoCity || isMorocco || hasMoroccoCityField)) {
                if (ticket.group_id === GROUP_IDS.MOROCCO) return { action: 'none' };
                const payload = { ticket: { group_id: GROUP_IDS.MOROCCO } };
                if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                RUMILogger.info('ROUTING', 'Morocco routing match', { ticketId: ticket.id });
                return { action: 'morocco', trigger: 'Morocco City/Tag Routing', payload };
            }

            // Care routing — comment-trigger based (latest comment only)
            if (!settings.actionTypes.care) return { action: 'none' };

            if (comments.length > 0) {
                const latestComment = comments[comments.length - 1];
                const triggerResult = await this.checkCommentForTriggers(latestComment, settings, enabledTriggers);
                if (triggerResult?.type === 'care') {
                    if (ticket.group_id === GROUP_IDS.CARE) return { action: 'none' };
                    const payload = { ticket: { group_id: GROUP_IDS.CARE } };
                    if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                    RUMILogger.info('ROUTING', 'Care routing phrase match', { ticketId: ticket.id, trigger: triggerResult.trigger });
                    return { action: 'care', trigger: `Routing phrase: ${triggerResult.trigger}`, payload };
                }
            }

            // Care routing — noActivityDetails subject
            if (ticket.subject?.toLowerCase().includes('noactivitydetails available') && ticket.status === 'new') {
                const hasPrivateComments = comments.some(c => c.public === false);
                if (!hasPrivateComments) {
                    if (ticket.group_id === GROUP_IDS.CARE) return { action: 'none' };
                    return { action: 'care', trigger: 'Subject: noActivityDetails available', payload: { ticket: { group_id: GROUP_IDS.CARE, status: 'open' } } };
                }
            }

            // Care routing — IRT concern
            if (ticket.requester_id === CONFIG.CAREEM_CARE_ID) {
                for (const comment of comments) {
                    const normalized = RUMICommentProcessor.normalizeForMatching(comment.html_body);
                    if (normalized.includes('irt concern has been handled')) {
                        if (ticket.group_id === GROUP_IDS.CARE) return { action: 'none' };
                        const payload = { ticket: { group_id: GROUP_IDS.CARE } };
                        if (ticket.status === 'pending' || ticket.status === 'solved') payload.ticket.status = 'open';
                        RUMILogger.info('ROUTING', 'IRT concern handled — routing to Care', { ticketId: ticket.id });
                        return { action: 'care', trigger: 'IRT concern handled', payload };
                    }
                }
            }

            return { action: 'none' };
        }

        // ── Escalation response rules ──────────────────────────────────────────
        static async evaluateEscalationResponseRules(ticket, comments, settings, viewName = null, hasRequiredPhrases = null, enabledTriggers = null) {
            if (!settings.actionTypes.pending) return { action: 'none' };
            const _hasRequired = hasRequiredPhrases !== null ? hasRequiredPhrases : this.hasRequiredCommentPhrases(comments);
            if (!_hasRequired) return { action: 'none' };
            if (comments.length === 0) return { action: 'none' };

            const latestComment = comments[comments.length - 1];
            const latestAuthor = await this.getUserRole(latestComment.author_id);
            const latestNormalized = RUMICommentProcessor.normalizeForMatching(latestComment.html_body);
            const isLatestRFR = latestNormalized.includes('careem.rfr') || latestNormalized.includes('global.rfr');
            const escalationPhrase = RUMIRules.ESCALATED_BUT_NO_RESPONSE.toLowerCase();

            if (latestNormalized.includes(escalationPhrase)) return { action: 'none' };
            if (!latestAuthor.isEndUser && !isLatestRFR) return { action: 'none' };

            const startIndex = Math.max(0, comments.length - CONFIG.TRACE_BACK_COMMENT_LIMIT);
            let commentBeforeChain = null;

            for (let i = comments.length - 2; i >= startIndex; i--) {
                const comment = comments[i];
                const author = await this.getUserRole(comment.author_id);
                const normalized = RUMICommentProcessor.normalizeForMatching(comment.html_body);
                const isRFR = normalized.includes('careem.rfr') || normalized.includes('global.rfr');
                if (!author.isEndUser && !isRFR) { commentBeforeChain = comment; break; }
            }

            if (!commentBeforeChain) return { action: 'none' };

            if (commentBeforeChain.public === false) {
                const normalized = RUMICommentProcessor.normalizeForMatching(commentBeforeChain.html_body);
                if (normalized.includes(escalationPhrase)) {
                    const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                    if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                    RUMILogger.info('PROCESSOR', 'Escalation-but-no-response rule matched', { ticketId: ticket.id });
                    return { action: 'pending', trigger: 'ESCALATED_BUT_NO_RESPONSE', payload };
                }
            }

            return { action: 'none' };
        }

        // ── Pending rules ──────────────────────────────────────────────────────
        static async evaluatePendingRules(ticket, comments, settings, viewName = null, hasRequiredPhrases = null, enabledTriggers = null) {
            if (!settings.actionTypes.pending) return { action: 'none' };
            const _hasRequired = hasRequiredPhrases !== null ? hasRequiredPhrases : this.hasRequiredCommentPhrases(comments);
            if (!_hasRequired) return { action: 'none' };

            let firstEndUserCommentIndex = comments.length - 1;
            let isChainValid = false;

            if (firstEndUserCommentIndex >= 0) {
                const lastCommentRole = await this.getUserRole(comments[firstEndUserCommentIndex].author_id);
                if (lastCommentRole.isEndUser) isChainValid = true;
            }

            if (isChainValid) {
                while (firstEndUserCommentIndex >= 0) {
                    const role = await this.getUserRole(comments[firstEndUserCommentIndex].author_id);
                    if (!role.isEndUser) break;
                    firstEndUserCommentIndex--;
                }

                if (firstEndUserCommentIndex >= 0) {
                    const commentBeforeChain = comments[firstEndUserCommentIndex];
                    if (commentBeforeChain.author_id.toString() === '35067366305043') {
                        const normalizedBeforeComment = RUMICommentProcessor.normalizeForMatching(commentBeforeChain.html_body);
                        const requiredPhrases = ['careeminboundphone', 'incident type', 'customer language', 'customer words'];
                        if (requiredPhrases.some(p => normalizedBeforeComment.includes(p))) {
                            const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                            if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                            RUMILogger.info('PROCESSOR', 'Pending: end-user chain after bot comment', { ticketId: ticket.id });
                            return { action: 'pending', trigger: 'End user chain preceded by required phrases from user 35067366305043', payload };
                        }
                    }
                }
            }

            const commentToCheck = await this.findCommentToCheck(comments);
            if (!commentToCheck) return { action: 'none' };

            const linkResult = await this._evaluateLinkTrigger(commentToCheck, comments, settings, viewName, ticket, enabledTriggers);
            if (linkResult !== null) return linkResult;

            const triggerResult = await this.checkCommentForTriggers(commentToCheck, settings, enabledTriggers);

            if (triggerResult?.type === 'pending') {
                const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                RUMILogger.info('PROCESSOR', 'Pending trigger matched', { ticketId: ticket.id, trigger: triggerResult.trigger.substring(0, 60) });
                return { action: 'pending', trigger: triggerResult.trigger.substring(0, 500), payload };
            }

            // Preceding comment fallback
            if (commentToCheck.public === false && commentToCheck.author_id.toString() === CONFIG.CAREEM_CARE_ID) {
                const commentIndex = comments.findIndex(c => c.id === commentToCheck.id);
                if (commentIndex > 0) {
                    const precedingComment = comments[commentIndex - 1];
                    if (precedingComment.author_id.toString() === CONFIG.CAREEM_CARE_ID) {
                        const precedingTriggerResult = await this.checkCommentForTriggers(precedingComment, settings, enabledTriggers);
                        if (precedingTriggerResult?.type === 'pending') {
                            const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                            if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                            return { action: 'pending', trigger: `Preceding: ${precedingTriggerResult.trigger.substring(0, 40)}...`, payload };
                        }
                    }
                }
            }

            return { action: 'none' };
        }

        // ── Solved rules ───────────────────────────────────────────────────────
        static async evaluateSolvedRules(ticket, comments, settings, hasRequiredPhrases = null, enabledTriggers = null) {
            if (!settings.actionTypes.solved) return { action: 'none' };
            const _hasRequired = hasRequiredPhrases !== null ? hasRequiredPhrases : this.hasRequiredCommentPhrases(comments);
            if (!_hasRequired) return { action: 'none' };

            const commentToCheck = await this.findCommentToCheck(comments);
            if (!commentToCheck) return { action: 'none' };

            const linkResult = await this._evaluateLinkTrigger(commentToCheck, comments, settings, null, ticket, enabledTriggers);
            if (linkResult !== null) return linkResult;

            const latestComment = comments[comments.length - 1];
            const latestAuthor = await this.getUserRole(latestComment.author_id);
            const isTracedBackFromEndUser = latestAuthor.isEndUser && commentToCheck.id !== latestComment.id;

            const triggerResult = await this.checkCommentForTriggers(commentToCheck, settings, enabledTriggers);

            if (triggerResult?.type === 'solved') {
                const userId = await this.ensureCurrentUserId();
                if (isTracedBackFromEndUser) {
                    return { action: 'pending', trigger: `end-user comment after: ${triggerResult.trigger.substring(0, 60)}`, payload: { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } } };
                }
                RUMILogger.info('PROCESSOR', 'Solved trigger matched', { ticketId: ticket.id, trigger: triggerResult.trigger.substring(0, 60) });
                return { action: 'solved', trigger: triggerResult.trigger.substring(0, 500), payload: { ticket: { status: 'solved', assignee_id: userId } } };
            }

            // Preceding comment fallback
            if (commentToCheck.public === false && commentToCheck.author_id.toString() === CONFIG.CAREEM_CARE_ID) {
                const commentIndex = comments.findIndex(c => c.id === commentToCheck.id);
                if (commentIndex > 0) {
                    const precedingComment = comments[commentIndex - 1];
                    if (precedingComment.author_id.toString() === CONFIG.CAREEM_CARE_ID) {
                        const precedingTriggerResult = await this.checkCommentForTriggers(precedingComment, settings, enabledTriggers);
                        if (precedingTriggerResult?.type === 'solved') {
                            const userId = await this.ensureCurrentUserId();
                            if (isTracedBackFromEndUser) {
                                return { action: 'pending', trigger: `end-user after: Preceding: ${precedingTriggerResult.trigger.substring(0, 40)}...`, payload: { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } } };
                            }
                            return { action: 'solved', trigger: `Preceding: ${precedingTriggerResult.trigger.substring(0, 40)}...`, payload: { ticket: { status: 'solved', assignee_id: userId } } };
                        }
                    }
                }
            }

            return { action: 'none' };
        }

        // ── Link-trigger helper (shared by pending + solved rules) ─────────────────
        // Returns an action result if a link trigger is found, or null if not applicable.
        static async _evaluateLinkTrigger(commentToCheck, comments, settings, viewName, ticket, enabledTriggers = null) {
            if (commentToCheck.public !== false || commentToCheck.author_id.toString() !== CONFIG.CAREEM_CARE_ID) return null;
            const linkTriggers = [
                "https://blissnxt.uberinternal.com",
                "https://uber.lighthouse-cloud.com",
                "https://apps.mypurecloud.ie"
            ];
            const normalizedComment = RUMICommentProcessor.normalizeForMatching(commentToCheck.html_body);
            const hasLinkTrigger = linkTriggers.some(l => RUMICommentProcessor.matchesTrigger(normalizedComment, l));
            if (!hasLinkTrigger) return null;

            const commentIndex = comments.findIndex(c => c.id === commentToCheck.id);
            if (commentIndex > 0) {
                const precedingComment = comments[commentIndex - 1];
                const precedingTriggerResult = await this.checkCommentForTriggers(precedingComment, settings, enabledTriggers);
                if (precedingTriggerResult?.type === 'solved') {
                    const userId = await this.ensureCurrentUserId();
                    return { action: 'solved', trigger: `Link trigger with solved preceding: ${precedingTriggerResult.trigger.substring(0, 40)}...`, payload: { ticket: { status: 'solved', assignee_id: userId } } };
                }
                const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                if (viewName && this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                return { action: 'pending', trigger: `Link trigger with ${precedingTriggerResult ? 'non-solved' : 'no'} preceding trigger`, payload };
            }
            return { action: 'none' };
        }

        // ── Status rules (customer reply + agent public reply) ─────────────────
        static async evaluateStatusRules(ticket, comments, settings, viewName, enabledTriggers = null) {
            if (comments.length === 0) return { action: 'none' };

            const latestComment = comments[comments.length - 1];
            const latestAuthor = await this.getUserRole(latestComment.author_id);

            // Customer reply → Pending
            if (latestAuthor.isEndUser) {
                if (ticket.status === 'pending') return { action: 'none' };
                if (settings.actionTypes.customerReplyPending) {
                    const hasActionsRequiredNote = comments.some(c => {
                        if (c.public !== false) return false;
                        const normalized = RUMICommentProcessor.normalizeForMatching(c.html_body);
                        return normalized.includes('actions required') || normalized.includes('action required');
                    });
                    if (hasActionsRequiredNote) return { action: 'none' };
                }
                const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                RUMILogger.info('PROCESSOR', 'Customer reply → Pending', { ticketId: ticket.id });
                return { action: 'pending', trigger: 'Customer Reply (Auto-Pending)', payload };
            }

            // Internal note from Careem Care → check last public comment
            if (latestComment.author_id.toString() === CONFIG.CAREEM_CARE_ID && latestComment.public === false) {
                let lastPublicComment = null;
                for (let i = comments.length - 1; i >= 0; i--) {
                    if (comments[i].public === true) { lastPublicComment = comments[i]; break; }
                }
                if (lastPublicComment) {
                    const triggerResult = await this.checkCommentForTriggers(lastPublicComment, settings, enabledTriggers);
                    if (triggerResult?.type === 'solved') {
                        const userId = await this.ensureCurrentUserId();
                        return { action: 'solved', trigger: `Internal Note follows Solved Trigger: ${triggerResult.trigger}`, payload: { ticket: { status: 'solved', assignee_id: userId } } };
                    } else if (triggerResult?.type === 'pending') {
                        if (ticket.status === 'pending') return { action: 'none' };
                        const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                        if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                        return { action: 'pending', trigger: `Internal Note follows Pending Trigger: ${triggerResult.trigger}`, payload };
                    }
                }
            }

            // Agent public reply → check triggers
            if (latestComment.public === true && !latestAuthor.isEndUser) {
                const triggerResult = await this.checkCommentForTriggers(latestComment, settings, enabledTriggers);
                if (triggerResult?.type === 'solved') {
                    const userId = await this.ensureCurrentUserId();
                    return { action: 'solved', trigger: `Agent Public Reply Solved Trigger: ${triggerResult.trigger}`, payload: { ticket: { status: 'solved', assignee_id: userId } } };
                } else if (triggerResult?.type === 'pending') {
                    if (ticket.status === 'pending') return { action: 'none' };
                    const payload = { ticket: { status: 'pending', assignee_id: Number(CONFIG.CAREEM_CARE_ID) } };
                    if (this._isSpecialView(viewName) && ticket.priority !== 'normal') payload.ticket.priority = 'normal';
                    return { action: 'pending', trigger: `Agent Public Reply Pending Trigger: ${triggerResult.trigger}`, payload };
                }
            }

            return { action: 'none' };
        }

        // ── Helpers ────────────────────────────────────────────────────────────
        static _isSpecialView(viewName) {
            if (!viewName) return false;
            const viewId = RUMIUI?.viewsMap?.get(viewName);
            return viewId && ['360069695114', '360000843468'].includes(String(viewId));
        }

        static hasRequiredCommentPhrases(comments) {
            // FIX-10: thin wrapper — delegates to combined scanner for backward compat
            return this.checkSafetyAndRequiredPhrases(comments).hasRequired;
        }

        static async findCommentToCheck(comments) {
            if (comments.length === 0) return null;
            const latestComment = comments[comments.length - 1];
            const latestAuthor = await this.getUserRole(latestComment.author_id);

            if (latestAuthor.isEndUser) {
                const startIndex = Math.max(0, comments.length - CONFIG.TRACE_BACK_COMMENT_LIMIT);
                for (let i = comments.length - 2; i >= startIndex; i--) {
                    if (comments[i].author_id.toString() === CONFIG.CAREEM_CARE_ID) return comments[i];
                }
                return null;
            }
            // Intentional: only CAREEM_CARE_ID agent comments are used as the candidate for
            // trigger matching. Comments from other agent IDs return null — they are not
            // expected to contain pending/solved trigger phrases in this workflow.
            if (latestComment.author_id.toString() === CONFIG.CAREEM_CARE_ID) return latestComment;
            return null;
        }

        // FIX-09: accept pre-computed enabledTriggers to avoid recomputing per comment
        static async checkCommentForTriggers(comment, settings, enabledTriggers = null) {
            const normalized = RUMICommentProcessor.normalizeForMatching(comment.html_body);

            const enabledCareRouting = enabledTriggers?.care ??
                RUMIRules.CARE_ROUTING_PHRASES.filter(p => settings.triggerPhrases.careRouting[p] !== false);
            const careTrigger = enabledCareRouting.find(p => RUMICommentProcessor.matchesTrigger(normalized, p));
            if (careTrigger) {
                if (normalized.includes('duplicate') || normalized.includes('duplicated')) {
                    return { type: 'solved', trigger: 'duplicate_case' };
                }
                return { type: 'care', trigger: careTrigger };
            }

            const enabledPending = enabledTriggers?.pending ??
                RUMIRules.PENDING_TRIGGERS.filter(p => settings.triggerPhrases.pending[p] !== false);
            const enabledSolved = enabledTriggers?.solved ??
                RUMIRules.SOLVED_TRIGGERS.filter(p => settings.triggerPhrases.solved[p] !== false);

            const pendingTrigger = enabledPending.find(p => RUMICommentProcessor.matchesTrigger(normalized, p));
            const solvedTrigger  = enabledSolved.find(p => RUMICommentProcessor.matchesTrigger(normalized, p));

            if (solvedTrigger && pendingTrigger) return { type: 'solved', trigger: solvedTrigger };
            if (pendingTrigger) return { type: 'pending', trigger: pendingTrigger };
            if (solvedTrigger) return { type: 'solved', trigger: solvedTrigger };
            return null;
        }

        static async getUserRole(userId) {
            // BUG-05 FIX: check per-pass Map cache before making a live API call
            const key = String(userId);
            if (this._userRoleCache.has(key)) return this._userRoleCache.get(key);
            try {
                if (key === CONFIG.CAREEM_CARE_ID) {
                    const result = { isEndUser: false, role: 'agent' };
                    this._userRoleCache.set(key, result);
                    return result;
                }
                const userData = await RUMIAPIManager.get(`/api/v2/users/${userId}.json`);
                const result = { isEndUser: userData.user.role === 'end-user', role: userData.user.role };
                this._userRoleCache.set(key, result);
                return result;
            } catch (error) {
                RUMILogger.warn('PROCESSOR', 'Failed to fetch user role, assuming agent', { userId, error: error.message });
                const fallback = { isEndUser: false, role: 'unknown' };
                this._userRoleCache.set(key, fallback);
                return fallback;
            }
        }

        static _groupNameCache = new Map();

        static async fetchAndCacheGroupName(groupId) {
            if (!groupId) return 'N/A';
            if (this._groupNameCache.has(String(groupId))) return this._groupNameCache.get(String(groupId));
            const fromStorage = RUMIStorage.getGroupName(groupId);
            if (fromStorage !== `Group ${groupId}`) {
                this._groupNameCache.set(String(groupId), fromStorage);
                return fromStorage;
            }
            try {
                const data = await RUMIAPIManager.get(`/api/v2/groups/${groupId}.json`);
                const name = data.group.name;
                RUMIStorage.cacheGroup(groupId, name);
                this._groupNameCache.set(String(groupId), name);
                return name;
            } catch { return `Group ${groupId}`; }
        }

        // BUG-FIX-10: merged single-pass scanner replacing two separate comment scans
        static checkSafetyAndRequiredPhrases(comments) {
            const requiredPhrases = ['careeminboundphone', 'incident type', 'customer language', 'customer words'];
            let hasSafetyGate = false, hasRequired = false;
            for (const comment of comments) {
                if (comment.public !== false) continue;
                const normalized = RUMICommentProcessor.normalizeForMatching(comment.html_body);
                if (normalized.includes('careeminboundphone')) hasSafetyGate = true;
                if (requiredPhrases.some(p => normalized.includes(p))) hasRequired = true;
                if (hasSafetyGate && hasRequired) break;
            }
            return { hasSafetyGate, hasRequired };
        }

        static checkSafetyGate(comments) {
            // FIX-10: thin wrapper — delegates to combined scanner for backward compat
            return this.checkSafetyAndRequiredPhrases(comments).hasSafetyGate;
        }

        static async applyChanges(ticketId, payload) {
            await RUMIAPIManager.put(`/api/v2/tickets/${ticketId}.json`, payload);
        }
    }

    // ============================================================================
    // STORAGE LAYER  (FIX: casablanca → morocco throughout)
    // ============================================================================

    class RUMIStorage {
        static get(key, defaultValue = null) {
            try {
                const value = GM_getValue('rumi_' + key);
                return value !== undefined ? JSON.parse(value) : defaultValue;
            } catch (error) {
                console.error('[RUMI STORAGE] Failed to parse stored value for key:', key, error);
                return defaultValue;
            }
        }

        static set(key, value) {
            try { GM_setValue('rumi_' + key, JSON.stringify(value)); }
            catch (error) { console.error('[RUMI STORAGE] Failed to store value:', key, error); }
        }

        static remove(key) {
            try { GM_deleteValue('rumi_' + key); }
            catch (error) { console.error('[RUMI STORAGE] Failed to remove value:', key, error); }
        }

        static getSelectedViews() { return this.get('selected_views', []); }
        static setSelectedViews(ids) { this.set('selected_views', ids); }
        static getLogs() { return this.get('logs', []); }

        static addLog(entry) {
            const logs = this.getLogs();
            logs.push(entry);
            if (logs.length > CONFIG.LOG_MAX_ENTRIES) logs.splice(0, logs.length - CONFIG.LOG_MAX_ENTRIES);
            this.set('logs', logs);
        }

        static getProcessingSettings() { return this.get('processing_settings', { automaticProcessing: false, dryRunMode: true }); }
        static setProcessingSettings(s) { this.set('processing_settings', s); }

        // FIX: unified stats — casablanca → morocco
        static _defaultStats() {
            return { totalProcessed: 0, pending: 0, solved: 0, care: 0, hala: 0, morocco: 0, bikeDispute: 0, egypt: 0, careEscalations: 0, errors: 0 };
        }

        static getProcessingStats() { return this.get('processing_stats', this._defaultStats()); }

        static updateProcessingStats(action) {
            const stats = { ...this._defaultStats(), ...this.getProcessingStats() };
            stats.totalProcessed++;
            if (action === 'pending') stats.pending++;
            else if (action === 'solved') stats.solved++;
            else if (action === 'care') stats.care++;
            else if (action === 'hala') stats.hala++;
            else if (action === 'morocco') stats.morocco++;
            else if (action === 'bikeDispute') stats.bikeDispute++;
            else if (action === 'egypt') stats.egypt++;
            else if (action === 'careEscalations') stats.careEscalations++;
            else if (action === 'error') stats.errors++;
            this.set('processing_stats', stats);
        }

        static resetProcessingStats() { this.remove('processing_stats'); }

        static getManualProcessingStats() { return this.get('manual_processing_stats', this._defaultStats()); }

        static updateManualProcessingStats(action) {
            const stats = { ...this._defaultStats(), ...this.getManualProcessingStats() };
            stats.totalProcessed++;
            if (action === 'pending') stats.pending++;
            else if (action === 'solved') stats.solved++;
            else if (action === 'care') stats.care++;
            else if (action === 'hala') stats.hala++;
            else if (action === 'morocco') stats.morocco++;
            else if (action === 'bikeDispute') stats.bikeDispute++;
            else if (action === 'egypt') stats.egypt++;
            else if (action === 'careEscalations') stats.careEscalations++;
            else if (action === 'error') stats.errors++;
            this.set('manual_processing_stats', stats);
        }

        static resetManualProcessingStats() { this.remove('manual_processing_stats'); }

        static getProcessedTickets() { return this.get('processed_tickets', []); }

        static addProcessedTicket(ticketData) {
            const action = ticketData.action;
            if (!action || ['none', 'skipped', 'error'].includes(action)) return false;

            const tickets = this.getProcessedTickets();
            const now = new Date();
            const isDuplicate = tickets.some(e =>
                e.ticketId === ticketData.ticketId &&
                e.action === ticketData.action &&
                (now - new Date(e.timestamp)) < 10000
            );
            if (isDuplicate) return false;
            tickets.push({ ...ticketData, timestamp: now.toISOString() });
            if (tickets.length > 1500) tickets.splice(0, tickets.length - 1500);
            this.set('processed_tickets', tickets);
            return true;
        }

        static clearProcessedTickets() { this.remove('processed_tickets'); }

        static getManualProcessedTickets() { return this.get('manual_processed_tickets', []); }

        static addManualProcessedTicket(ticketData) {
            const tickets = this.getManualProcessedTickets();
            const now = new Date();
            const isDuplicate = tickets.some(e =>
                e.ticketId === ticketData.ticketId &&
                e.action === ticketData.action &&
                (now - new Date(e.timestamp)) < 5000
            );
            if (isDuplicate) return false;
            tickets.push({ ...ticketData, timestamp: now.toISOString() });
            if (tickets.length > 3000) tickets.splice(0, tickets.length - 3000);
            this.set('manual_processed_tickets', tickets);
            return true;
        }

        static clearManualProcessedTickets() { this.remove('manual_processed_tickets'); }

        static getManualProcessingSettings() { return this.get('manual_processing_settings', { dryRunMode: true }); }
        static setManualProcessingSettings(s) { this.set('manual_processing_settings', s); }

        static getGroupCache() { return this.get('group_cache', {}); }
        static cacheGroup(id, name) { const c = this.getGroupCache(); c[id] = name; this.set('group_cache', c); }
        static getGroupName(id) { if (!id) return 'N/A'; const c = this.getGroupCache(); return c[id] || `Group ${id}`; }

        static getPinnedBlocked() { return this.get('pinned_blocked', []); }
        static setPinnedBlocked(pins) { this.set('pinned_blocked', pins); }
        static getPinnedCareRouting() { return this.get('pinned_care_routing', []); }
        static setPinnedCareRouting(pins) { this.set('pinned_care_routing', pins); }

        static addPinnedBlocked(ticketId, reason = 'manual') { const p = this.getPinnedBlocked(); p.push({ ticketId, timestamp: new Date().toISOString(), reason: reason || 'manual' }); this.setPinnedBlocked(p); }
        static addPinnedCareRouting(ticketId, commentId) { const p = this.getPinnedCareRouting(); p.push({ ticketId, timestamp: new Date().toISOString(), lastCommentId: commentId, status: 'active' }); this.setPinnedCareRouting(p); }
        static removePinnedBlocked(ticketId) { 
            this.setPinnedBlocked(this.getPinnedBlocked().filter(p => p.ticketId !== ticketId)); 
            this.resetRoutingCount(ticketId);
        }
        static removePinnedCareRouting(ticketId) { this.setPinnedCareRouting(this.getPinnedCareRouting().filter(p => p.ticketId !== ticketId)); }

        static getRoutingCount(ticketId) {
            return this.get(`routing_count_${ticketId}`, 0);
        }

        static incrementRoutingCount(ticketId) {
            const count = this.getRoutingCount(ticketId) + 1;
            this.set(`routing_count_${ticketId}`, count);
            return count;
        }

        static resetRoutingCount(ticketId) {
            this.remove(`routing_count_${ticketId}`);
        }

        static updatePinnedCareRoutingStatus(ticketId, status, commentId = null) {
            const pins = this.getPinnedCareRouting();
            const pin = pins.find(p => p.ticketId === ticketId);
            if (pin) {
                pin.status = status;
                if (status === 'changed') pin.lastCommentId = null;
                else if (commentId !== null) pin.lastCommentId = commentId;
                this.setPinnedCareRouting(pins);
            }
        }

        static isTicketPinned(ticketId) {
            return this.getPinnedBlocked().some(p => p.ticketId === ticketId) ||
                this.getPinnedCareRouting().some(p => p.ticketId === ticketId);
        }

        static _defaultActionTypes() {
            return { solved: true, pending: true, care: true, rta: true, morocco: false, egypt: true, bikeDispute: true, customerReplyPending: true };
        }

        static _settingsCache = { automatic: null, manual: null };
        static invalidateSettingsCache() { this._settingsCache = { automatic: null, manual: null }; }

        static getAutomaticSettings() {
            if (this._settingsCache.automatic) return this._settingsCache.automatic;
            const defaults = { actionTypes: this._defaultActionTypes(), pqmsSubmission: 'solved', triggerPhrases: { pending: {}, solved: {}, careRouting: {} } };
            const stored = this.get('rumi_settings_automatic', null);
            if (!stored) { const s = this.initializeSettings(defaults); this.setAutomaticSettings(s); return s; }
            const synced = this.syncTriggerPhrases(stored);
            if (synced !== stored) this.setAutomaticSettings(synced);
            this._settingsCache.automatic = synced;
            return synced;
        }

        static setAutomaticSettings(s) { this._settingsCache.automatic = null; this.set('rumi_settings_automatic', s); }

        static getManualSettings() {
            if (this._settingsCache.manual) return this._settingsCache.manual;
            const defaults = { actionTypes: this._defaultActionTypes(), pqmsSubmission: 'solved', triggerPhrases: { pending: {}, solved: {}, careRouting: {} } };
            const stored = this.get('rumi_settings_manual', null);
            if (!stored) { const s = this.initializeSettings(defaults); this.setManualSettings(s); return s; }
            const synced = this.syncTriggerPhrases(stored);
            if (synced !== stored) this.setManualSettings(synced);
            this._settingsCache.manual = synced;
            return synced;
        }

        static setManualSettings(s) { this._settingsCache.manual = null; this.set('rumi_settings_manual', s); }

        static initializeSettings(defaults) {
            const s = JSON.parse(JSON.stringify(defaults));
            RUMIRules.PENDING_TRIGGERS.forEach(p => { s.triggerPhrases.pending[p] = true; });
            RUMIRules.SOLVED_TRIGGERS.forEach(p => { s.triggerPhrases.solved[p] = true; });
            RUMIRules.CARE_ROUTING_PHRASES.forEach(p => { s.triggerPhrases.careRouting[p] = true; });
            return s;
        }

        static syncTriggerPhrases(settings) {
            let modified = false;
            const synced = JSON.parse(JSON.stringify(settings));
            if (!synced.triggerPhrases) { synced.triggerPhrases = { pending: {}, solved: {}, careRouting: {} }; modified = true; }
            ['pending', 'solved', 'careRouting'].forEach(k => { if (!synced.triggerPhrases[k]) { synced.triggerPhrases[k] = {}; modified = true; } });

            const curP = new Set(RUMIRules.PENDING_TRIGGERS);
            const curS = new Set(RUMIRules.SOLVED_TRIGGERS);
            const curC = new Set(RUMIRules.CARE_ROUTING_PHRASES);

            Object.keys(synced.triggerPhrases.pending).filter(p => !curP.has(p)).forEach(p => { delete synced.triggerPhrases.pending[p]; modified = true; });
            Object.keys(synced.triggerPhrases.solved).filter(p => !curS.has(p)).forEach(p => { delete synced.triggerPhrases.solved[p]; modified = true; });
            Object.keys(synced.triggerPhrases.careRouting).filter(p => !curC.has(p)).forEach(p => { delete synced.triggerPhrases.careRouting[p]; modified = true; });

            RUMIRules.PENDING_TRIGGERS.forEach(p => { if (!(p in synced.triggerPhrases.pending)) { synced.triggerPhrases.pending[p] = true; modified = true; } });
            RUMIRules.SOLVED_TRIGGERS.forEach(p => { if (!(p in synced.triggerPhrases.solved)) { synced.triggerPhrases.solved[p] = true; modified = true; } });
            RUMIRules.CARE_ROUTING_PHRASES.forEach(p => { if (!(p in synced.triggerPhrases.careRouting)) { synced.triggerPhrases.careRouting[p] = true; modified = true; } });

            return modified ? synced : settings;
        }

        static getUISettings() { return this.get('ui_settings', { theme: 'dark' }); }
        static setUISettings(s) { this.set('ui_settings', s); }

        static getPQMSUser() {
            const zId = RUMIProcessor.currentUserId;
            if (zId) {
                const opsId = ZENDESK_TO_PQMS_USER[String(zId)];
                if (opsId && PQMS_USERS[opsId]) return { opsId, name: PQMS_USERS[opsId] };
            }
            const saved = this.get('pqms_selected_user', null);
            if (saved && PQMS_USERS[saved.opsId]) return saved;
            return null;
        }

        static setPQMSUser(opsId, name) { if (opsId && name) this.set('pqms_selected_user', { opsId, name }); }
        static clearPQMSUser() { this.remove('pqms_selected_user'); }
        static getPQMSSubmissions() { return this.get('pqms_submissions', []); }

        static addPQMSSubmission(ticketId, ticketSubject, groupName) {
            const submissions = this.getPQMSSubmissions();
            const user = this.getPQMSUser();
            submissions.push({
                ticketId: ticketId.toString(), ticketSubject: ticketSubject || 'N/A',
                groupName: groupName || 'N/A', submittedBy: user?.name || 'Unknown',
                timestamp: new Date().toISOString()
            });
            if (submissions.length > 2000) submissions.splice(0, submissions.length - 2000);
            this.set('pqms_submissions', submissions);
        }

        static isTicketSubmittedToPQMS(ticketId) {
            return this.getPQMSSubmissions().some(s => s.ticketId === ticketId.toString());
        }

        static getPQMSSubmissionCount() { return this.getPQMSSubmissions().length; }

        // FIX: proper PQMS counters by status
        static getPQMSSolvedCount() { return this.get('pqms_solved_count', 0); }
        static getPQMSPendingCount() { return this.get('pqms_pending_count', 0); }
        static incrementPQMSSolved() { this.set('pqms_solved_count', this.getPQMSSolvedCount() + 1); }
        static incrementPQMSPending() { this.set('pqms_pending_count', this.getPQMSPendingCount() + 1); }
    }

    // ============================================================================
    // PQMS AUTOMATIC SUBMISSION
    // ============================================================================

    class RUMIPQMS {
        static submittingIds = new Set(); // BUG-06 FIX: per-ticketId set replaces global boolean

        static async _submit(ticketId, ticketSubject, groupName, status, isManual, force) {
            const globalEnabled = RUMIStorage.get('pqms_integration_enabled', 'on') !== 'off';
            if (!globalEnabled && !force) return false;

            const settings = isManual ? RUMIStorage.getManualSettings() : RUMIStorage.getAutomaticSettings();
            const pref = settings.pqmsSubmission || 'both';
            if (!force && pref !== status && pref !== 'both') return false;
            const ticketKey = String(ticketId);
            if (this.submittingIds.has(ticketKey)) return false; // BUG-06 FIX: per-ticket guard

            try {
                const selectedUser = RUMIStorage.getPQMSUser();
                if (!selectedUser?.opsId || !selectedUser?.name) return false;
                if (!PQMS_USERS[selectedUser.opsId]) return false;
                if (selectedUser.name !== PQMS_USERS[selectedUser.opsId]) return false;

                this.submittingIds.add(ticketKey); // BUG-06 FIX: mark this ticket as in-flight

                const params = new URLSearchParams({
                    'Ticket_ID': ticketId.toString(), 'SSOC_Reason': 'Felt Unsafe',
                    'Ticket_Type': 'Non - Critical', 'Ticket_Status': status === 'solved' ? 'Solved' : 'Pending',
                    'Attempts': 'NA', 'Escelated': '', 'Follow_Up': '', 'Comments': '',
                    'username': selectedUser.opsId, 'name': selectedUser.name
                });

                const url = `https://pqms05.extensya.com/Careem/ticket/submit_SSOC_ticket.php?${params.toString()}`;
                const iframe = document.createElement('iframe');
                Object.assign(iframe.style, { display: 'none', width: '0', height: '0', border: 'none' });

                let loadTimeout;
                const loadPromise = new Promise((resolve, reject) => {
                    iframe.onload = () => { clearTimeout(loadTimeout); resolve(); };
                    iframe.onerror = () => { clearTimeout(loadTimeout); reject(new Error('Failed to load PQMS endpoint')); };
                    loadTimeout = setTimeout(resolve, 10000);
                });

                document.body.appendChild(iframe);
                iframe.src = url;

                try {
                    await loadPromise;
                    RUMIStorage.addPQMSSubmission(ticketId, ticketSubject, groupName);
                    // FIX: reliable counters
                    if (status === 'solved') RUMIStorage.incrementPQMSSolved();
                    else RUMIStorage.incrementPQMSPending();
                    RUMILogger.info('PQMS', `Ticket ${ticketId} submitted to PQMS as ${status}`, { ticketId, groupName });
                    return true;
                } finally {
                    setTimeout(() => { if (iframe?.parentNode) iframe.parentNode.removeChild(iframe); }, 1000);
                }
            } catch (error) {
                // BUG-PQMS FIX: removed redundant submittingIds.delete here — the finally setTimeout handles cleanup
                RUMILogger.error('PQMS', `Failed to submit ${status} ticket`, { ticketId, error: error.message });
                return false;
            } finally {
                setTimeout(() => this.submittingIds.delete(ticketKey), 2000);
            }
        }

        static submitSolvedTicket(ticketId, ticketSubject, groupName, isManual = false, force = false) {
            return this._submit(ticketId, ticketSubject, groupName, 'solved', isManual, force);
        }

        static submitPendingTicket(ticketId, ticketSubject, groupName, isManual = false, force = false) {
            return this._submit(ticketId, ticketSubject, groupName, 'pending', isManual, force);
        }
    }

    // ============================================================================
    // PIN MANAGER
    // ============================================================================

    class RUMIPinManager {
        static async addPin(ticketId, pinType) {
            try {
                if (!ticketId?.trim()) { RUMIUI.showToast('Please enter a valid ticket ID', 'error'); return false; }
                const id = ticketId.trim();
                if (RUMIStorage.isTicketPinned(id)) { RUMIUI.showToast(`Ticket ${id} is already pinned`, 'warning'); return false; }

                if (pinType === 'blocked') {
                    RUMIStorage.addPinnedBlocked(id);
                    RUMILogger.info('PIN', `Ticket ${id} blocked from processing`);
                    RUMIUI.showToast(`Ticket ${id} blocked from processing`, 'success');
                } else if (pinType === 'care_routing') {
                    const comments = await RUMIAPIManager.get(`/api/v2/tickets/${id}/comments.json`);
                    if (!comments?.comments?.length) { RUMIUI.showToast(`Cannot pin ticket ${id}: No comments found`, 'error'); return false; }
                    const latestCommentId = comments.comments[comments.comments.length - 1].id;
                    RUMIStorage.addPinnedCareRouting(id, latestCommentId);
                    await this.processCareRoutingPin(id);
                    RUMILogger.info('PIN', `Ticket ${id} pinned for Care routing`);
                    RUMIUI.showToast(`Ticket ${id} pinned for Care routing`, 'success');
                }
                RUMIUI.renderPinnedList();
                return true;
            } catch (error) {
                RUMILogger.error('PIN', 'Failed to add pin', { ticketId, pinType, error: error.message });
                RUMIUI.showToast(`Failed to pin ticket: ${error.message}`, 'error');
                return false;
            }
        }

        static removePin(ticketId, pinType) {
            try {
                if (pinType === 'blocked') { RUMIStorage.removePinnedBlocked(ticketId); RUMIUI.showToast(`Ticket ${ticketId} unblocked`, 'success'); }
                else { RUMIStorage.removePinnedCareRouting(ticketId); RUMIUI.showToast(`Care routing pin removed for ticket ${ticketId}`, 'success'); }
                RUMILogger.info('PIN', `Pin removed for ticket ${ticketId}`, { pinType });
                RUMIUI.renderPinnedList();
                return true;
            } catch (error) {
                RUMILogger.error('PIN', 'Failed to remove pin', { ticketId, error: error.message });
                RUMIUI.showToast(`Failed to remove pin: ${error.message}`, 'error');
                return false;
            }
        }

        static checkBlockedPin(ticketId) {
            const isBlocked = RUMIStorage.getPinnedBlocked().some(p => p.ticketId === ticketId);
            if (isBlocked) RUMILogger.info('PIN', 'Ticket skipped — blocked pin', { ticketId });
            return isBlocked;
        }

        static async checkCareRoutingPin(ticketId, ticketData = null, commentsList = null) {
            const pin = RUMIStorage.getPinnedCareRouting().find(p => p.ticketId === ticketId);
            if (!pin) return null;
            if (pin.status === 'changed') return { action: 'skipped', reason: 'care_pin_changed' };

            try {
                if (!ticketData) { const r = await RUMIAPIManager.get(`/api/v2/tickets/${ticketId}.json`); ticketData = r.ticket; }
                if (ticketData.status === 'closed') return { action: 'skipped', reason: 'ticket_closed' };

                if (!commentsList) {
                    // BUG-CMTPAG FIX: use paginated fetchAllComments
                    commentsList = await RUMIAPIManager.fetchAllComments(ticketId);
                } else if (commentsList.comments) {
                    commentsList = commentsList.comments;
                }

                if (!commentsList?.length) return { action: 'skipped', reason: 'no_comments' };

                const latestCommentId = commentsList[commentsList.length - 1].id;
                const payload = { ticket: { group_id: GROUP_IDS.CARE } };
                if (ticketData.status !== 'open') payload.ticket.status = 'open';

                if (latestCommentId !== pin.lastCommentId) {
                    // BUG-08 FIX: update status and skip on THIS call; the skip on 'changed' status
                    // was previously deferred until the NEXT poll, causing one extra routing action.
                    RUMIStorage.updatePinnedCareRoutingStatus(ticketId, 'changed', latestCommentId);
                    return { action: 'skipped', reason: 'care_pin_new_comment' };
                }

                return { action: 'care', trigger: 'Care Routing Pin', payload };
            } catch (error) {
                RUMILogger.error('PIN', 'Error checking care routing pin', { ticketId, error: error.message });
                return { action: 'error', error: error.message };
            }
        }

        static async processCareRoutingPin(ticketId) {
            try {
                const ticket = await RUMIAPIManager.get(`/api/v2/tickets/${ticketId}.json`);
                const ticketData = ticket.ticket;
                if (ticketData.status === 'closed') return;

                const payload = { ticket: { group_id: GROUP_IDS.CARE } };
                if (ticketData.status !== 'open') payload.ticket.status = 'open';

                const previousGroupName = await RUMIProcessor.fetchAndCacheGroupName(ticketData.group_id);
                const newGroupName = await RUMIProcessor.fetchAndCacheGroupName(GROUP_IDS.CARE);

                if (!RUMIProcessor.isDryRun) await RUMIProcessor.applyChanges(ticketId, payload);

                RUMIStorage.addProcessedTicket({
                    ticketId, subject: ticketData.subject || 'N/A', viewName: 'Pinned Ticket',
                    action: 'care', trigger: 'pinned ticket',
                    previousStatus: ticketData.status, newStatus: payload.ticket.status || ticketData.status,
                    previousGroupId: ticketData.group_id, previousGroupName,
                    newGroupId: GROUP_IDS.CARE, newGroupName,
                    previousAssigneeId: ticketData.assignee_id, newAssigneeId: ticketData.assignee_id,
                    dryRun: RUMIProcessor.isDryRun, alreadyCorrect: false, note: null
                });
                RUMIStorage.updateProcessingStats('care');
                RUMILogger.info('PIN', `Care routing pin processed for ticket ${ticketId}`);
            } catch (error) {
                RUMILogger.error('PIN', 'Failed to process care routing pin', { ticketId, error: error.message });
            }
        }
    }

    // ============================================================================
    // LOGGING LAYER
    // ============================================================================

    class RUMILogger {
        static isManualProcessing = false;
        static _renderLogsDebounceTimer = null; // BUG-10 FIX: debounce timer for UI renders

        static debug(module, message, meta = {}) { if (this.isManualProcessing && module === 'API') return; this.log('debug', module, message, meta); }
        static info(module, message, meta = {}) { if (module === 'UI' && message === 'Saved selected views') return; this.log('info', module, message, meta); }
        static warn(module, message, meta = {}) { this.log('warn', module, message, meta); }
        static error(module, message, meta = {}) { this.log('error', module, message, meta); }

        static log(level, module, message, meta) {
            const entry = { timestamp: new Date().toISOString(), level, module, message, meta: this.sanitizeMeta(meta) };
            // Storage write is synchronous (immediate)
            try { RUMIStorage.addLog(entry); } catch (e) { console.error('[RUMI LOGGER] Storage failure:', e); }
            // BUG-10 FIX: debounce UI re-render to 300ms to prevent constant DOM repaints during batch processing
            if (this._renderLogsDebounceTimer) clearTimeout(this._renderLogsDebounceTimer);
            this._renderLogsDebounceTimer = setTimeout(() => {
                this._renderLogsDebounceTimer = null;
                try { if (typeof RUMIUI !== 'undefined' && RUMIUI.renderLogs) RUMIUI.renderLogs(); } catch (e) { /* UI not ready */ }
            }, 300);
        }

        static sanitizeMeta(meta) {
            const s = { ...meta };
            ['csrfToken', 'authToken', 'password', 'token'].forEach(k => delete s[k]);
            return s;
        }
    }

    // ============================================================================
    // API LAYER
    // ============================================================================

    class RUMIAPIManager {
        static csrfToken = null;
        static retryConfig = { maxRetries: CONFIG.RETRY_MAX_ATTEMPTS, backoffMs: CONFIG.RETRY_BACKOFF_MS };
        static _rateLimitedUntil = 0; // epoch ms — all requests are held until this time clears

        static async init() {
            try {
                const meta = document.querySelector('meta[name="csrf-token"]');
                if (meta) { this.csrfToken = meta.content; RUMILogger.info('API', 'CSRF token extracted'); }
                else RUMILogger.warn('API', 'No CSRF token found in page');
            } catch (error) {
                RUMILogger.error('API', 'Failed to initialize API manager', { error: error.message });
            }
        }

        static async request(method, endpoint, data = null, attempt = 1) {
            // Respect a global rate-limit back-off imposed by a prior 429 response
            const waitMs = this._rateLimitedUntil - Date.now();
            if (waitMs > 0) await this.sleep(waitMs);

            const startTime = Date.now();
            const options = {
                method,
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                credentials: 'same-origin'
            };
            if (method !== 'GET' && this.csrfToken) options.headers['X-CSRF-Token'] = this.csrfToken;
            if (data && method !== 'GET') options.body = JSON.stringify(data);

            try {
                const response = await fetch(endpoint, options);
                const duration = Date.now() - startTime;

                if (response.status >= 200 && response.status < 300) {
                    RUMILogger.debug('API', `${method} ${endpoint} succeeded`, { status: response.status, duration });
                    return await response.json();
                }

                if (response.status === 429) {
                    // Honour Retry-After header; fall back to 60 s if missing
                    const retryAfter = parseInt(response.headers.get('Retry-After') || '60', 10);
                    const backoffMs = retryAfter * 1000;
                    this._rateLimitedUntil = Date.now() + backoffMs;
                    RUMILogger.warn('API', `Rate limited — backing off ${retryAfter}s (attempt ${attempt})`, { endpoint });
                    if (attempt <= 5) {
                        await this.sleep(backoffMs);
                        return this.request(method, endpoint, data, attempt + 1);
                    }
                    throw new Error(`Rate limit exceeded after ${attempt} attempts`);
                }

                if (response.status >= 500) {
                    if (attempt < this.retryConfig.maxRetries) { await this.sleep(this.retryConfig.backoffMs * Math.pow(2, attempt - 1)); return this.request(method, endpoint, data, attempt + 1); }
                    throw new Error(`Server error after ${attempt} attempts`);
                }

                if (response.status === 401 || response.status === 403) throw new Error(`Permission denied: ${response.status}`);
                throw new Error(`API Error: ${response.status}`);
            } catch (error) {
                if (!error.message.startsWith('Rate limit') && !error.message.startsWith('Server error') &&
                    !error.message.startsWith('Permission denied') && !error.message.startsWith('API Error')) {
                    RUMILogger.error('API', 'Network error', { endpoint, error: error.message });
                }
                throw error;
            }
        }

        static async get(endpoint) { return this.request('GET', endpoint); }
        static async put(endpoint, data) { return this.request('PUT', endpoint, data); }
        static sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        // BUG-CMTPAG FIX: paginate through all comment pages (100 per page, asc order)
        static async fetchAllComments(ticketId) {
            let url = `/api/v2/tickets/${ticketId}/comments.json?per_page=100&sort_order=asc`;
            const allComments = [];
            let pageCount = 0;
            while (url) {
                pageCount++;
                const data = await this.get(url);
                allComments.push(...(data.comments || []));
                // Strip to pathname+search only to avoid CORS issues with full absolute URLs
                url = data.next_page
                    ? new URL(data.next_page).pathname + new URL(data.next_page).search
                    : null;
                if (url) await this.sleep(100);
            }
            return allComments;
        }
    }

    // ============================================================================
    // MONITORING ENGINE
    // ============================================================================

    class RUMIMonitor {
        static isRunning = false;
        static intervalId = null;
        static selectedViews = [];
        static intervalSeconds = CONFIG.DEFAULT_INTERVAL_SECONDS;
        static baselineTickets = new Map();
        static manualProcessingCancelled = false;
        static failedPolls = new Map();
        static pollCount = 0;
        static fullSweepInterval = 10;

        // BUG-VPAG FIX: shared cursor-based pagination helper for view ticket IDs
        static async fetchViewTicketIds(viewId) {
            let url = `/api/v2/views/${viewId}/execute.json?page[size]=100`;
            const allIds = [];
            while (url) {
                const data = await RUMIAPIManager.get(url);
                const pageIds = (data.rows || data.tickets || [])
                    .map(item => String(item.id || item.ticket_id || item.ticket?.id)).filter(Boolean);
                allIds.push(...pageIds);
                if (data.meta?.has_more && data.meta?.after_cursor) {
                    url = `/api/v2/views/${viewId}/execute.json?page[size]=100&page[after]=${data.meta.after_cursor}`;
                    await new Promise(r => setTimeout(r, 300));
                } else {
                    url = null;
                }
            }
            return allIds;
        }

        static async start() {
            if (this.isRunning) { RUMILogger.warn('MONITOR', 'Already running'); return false; }

            this.selectedViews = RUMIStorage.getSelectedViews();

            if (!Array.isArray(this.selectedViews) || this.selectedViews.length === 0) {
                const domSelected = Array.from(document.querySelectorAll('.cyber-toggle-checkbox[data-view-id]:checked'))
                    .map(cb => String(cb.dataset.viewId));
                if (domSelected.length > 0) { this.selectedViews = domSelected; RUMIStorage.setSelectedViews(domSelected); }
                else { RUMIUI.showToast('Please select at least one view to monitor', 'warning'); return false; }
            }

            this.isRunning = true;
            this.pollCount = 0;
            this.baselineTickets.clear();
            this.failedPolls.clear();
            RUMIUI.updateConnectionStatus('monitoring');
            RUMIUI.showToast('Starting monitoring — processing existing tickets...', 'info');
            RUMILogger.info('MONITOR', 'Monitoring started', { views: this.selectedViews.length, interval: this.intervalSeconds });

            try {
                await this.processExistingAndEstablishBaseline();
                RUMIUI.showToast('Baseline established — monitoring for new tickets', 'success');
                RUMILogger.info('MONITOR', 'Baseline established');
            } catch (error) {
                RUMILogger.error('MONITOR', 'Baseline failed, monitoring anyway', { error: error.message });
                RUMIUI.showToast('Baseline failed — monitoring started without baseline', 'warning');
            }

            if (this.intervalId) clearInterval(this.intervalId);
            this.intervalId = setInterval(() => {
                if (this.isRunning) this.poll().catch(e => RUMILogger.error('MONITOR', 'Poll error', { error: e.message }));
            }, this.intervalSeconds * 1000);

            return true;
        }

        static async processExistingAndEstablishBaseline() {
            RUMIProcessor._userRoleCache = new Map();
            for (const viewId of this.selectedViews) {
                try {
                    const viewName = await RUMIUI.getViewName(viewId);

                    // BUG-VPAG FIX: replace duplicated while-loop with shared helper
                    const allTicketIds = await this.fetchViewTicketIds(viewId);

                    this.baselineTickets.set(viewId, new Set(allTicketIds));
                    RUMILogger.info('MONITOR', `Baseline for "${viewName}": ${allTicketIds.length} tickets`);

                    for (let i = 0; i < allTicketIds.length; i += 3) {
                        const batch = allTicketIds.slice(i, i + 3);
                        await Promise.all(batch.map(async id => {
                            try {
                                const result = await RUMIProcessor.processTicket(String(id), viewName);
                                if (result.action && !['none', 'skipped', 'error'].includes(result.action)) {
                                    RUMIUI.updateCounters();
                                    RUMIUI.renderActiveAutoTab();
                                }
                            } catch (e) { RUMILogger.error('MONITOR', `Baseline error ${id}`, { error: e.message }); }
                        }));
                        await new Promise(r => setTimeout(r, 200));
                    }
                } catch (error) {
                    RUMILogger.error('MONITOR', `Failed baseline for view ${viewId}`, { error: error.message });
                }
            }
        }

        static stop() {
            if (!this.isRunning) return;
            this.isRunning = false;
            if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
            this.baselineTickets.clear();
            this.failedPolls.clear();
            if (!this._liveReloading) RUMIUI.updateConnectionStatus('offline');
            if (!this._liveReloading) RUMILogger.info('MONITOR', 'Monitoring stopped');
        }

        static _liveReloading = false;

        static async _hotReload(settingLabel) {
            if (!this.isRunning) return;
            this._liveReloading = true;
            RUMILogger.info('SETTINGS', `[Live Reload] ${settingLabel}`);
            this.stop();
            await new Promise(r => setTimeout(r, 500));
            this._liveReloading = false;
            await this.start();
            RUMIUI.showToast(`${settingLabel} — monitoring reloaded`, 'info');
        }

        static isPollRunning = false;

        static async poll() {
            if (!this.isRunning) return;
            if (this.isPollRunning) {
                RUMILogger.warn('MONITOR', 'Poll skipped — previous poll still running');
                return;
            }
            this.isPollRunning = true;
            try {
                RUMIProcessor._userRoleCache = new Map();
                this.pollCount++;
                const isFullSweep = (this.pollCount % this.fullSweepInterval === 0);

                for (const viewId of this.selectedViews) {
                    if (!this.isRunning) break;
                    try {
                        const viewName = await RUMIUI.getViewName(viewId);
                        // Intentional: poll uses a single-page fetch for cost efficiency. Full
                        // pagination on every interval would multiply API calls by page count.
                        // If the view exceeds 100 tickets, only the first page is visible to the
                        // poll; the baseline handles full coverage on start-up.
                        const data = await RUMIAPIManager.get(`/api/v2/views/${viewId}/execute.json?page[size]=100`);
                        const ticketIds = (data.rows || data.tickets || [])
                            .map(item => String(item.id || item.ticket_id || item.ticket?.id)).filter(Boolean);
                        if (data.meta?.has_more) {
                            RUMILogger.warn('MONITOR', `View "${viewName}" exceeds 100 tickets — poll only sees first page`, { viewId });
                        }

                        const hadFailedPoll = this.failedPolls.has(viewId);
                        if (hadFailedPoll) this.failedPolls.delete(viewId);

                        // BUG-SWEEP FIX: on full-sweep cycles, re-fetch all pages to get every ticket ID
                        const allViewIds = isFullSweep ? await this.fetchViewTicketIds(viewId) : ticketIds;
                        const baselineIds = this.baselineTickets.get(viewId) || new Set();
                        const toProcess = (isFullSweep || hadFailedPoll)
                            ? allViewIds
                            : ticketIds.filter(id => !baselineIds.has(String(id)));

                        if (toProcess.length > 0) {
                            RUMILogger.debug('MONITOR', `Poll: ${toProcess.length} tickets in "${viewName}"`, { isFullSweep });
                            for (let i = 0; i < toProcess.length; i += 3) {
                                if (!this.isRunning) break;
                                await Promise.all(toProcess.slice(i, i + 3).map(async id => {
                                    try {
                                        const result = await RUMIProcessor.processTicket(String(id), viewName);
                                        if (result.action && !['none', 'skipped', 'error'].includes(result.action)) {
                                            RUMIUI.updateCounters();
                                            RUMIUI.renderActiveAutoTab();
                                        }
                                    } catch (e) { RUMILogger.error('MONITOR', `Poll error ${id}`, { error: e.message }); }
                                }));
                                await new Promise(r => setTimeout(r, 200));
                            }
                        }

                        this.baselineTickets.set(viewId, new Set(ticketIds.map(String)));
                    } catch (error) {
                        this.failedPolls.set(viewId, (this.failedPolls.get(viewId) || 0) + 1);
                        RUMILogger.error('MONITOR', `Failed to poll view ${viewId}`, { error: error.message });
                        // If we just hit a rate limit, pause the entire poll cycle until the back-off clears
                        if (error.message.includes('Rate limit') || error.message.includes('429')) {
                            const holdMs = RUMIAPIManager._rateLimitedUntil - Date.now();
                            if (holdMs > 0) {
                                RUMILogger.warn('MONITOR', `Rate limited — pausing poll ${Math.ceil(holdMs / 1000)}s`);
                                await new Promise(r => setTimeout(r, holdMs));
                            }
                        }
                    }
                }

                RUMIUI.updateLastRunTime();
            } finally {
                this.isPollRunning = false;
            }
        }

        static async manualProcess(ticketIdsString, progressCallback = null) {
            const ticketIds = ticketIdsString.split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id));
            if (!ticketIds.length) return { processed: 0, actioned: 0 };

            this.manualProcessingCancelled = false;
            RUMILogger.isManualProcessing = true;
            RUMILogger.info('MONITOR', `Manual processing started`, { count: ticketIds.length });

            let processedCount = 0, actionCount = 0;

            for (let i = 0; i < ticketIds.length; i += 3) {
                if (this.manualProcessingCancelled) break;
                await Promise.all(ticketIds.slice(i, i + 3).map(async id => {
                    if (this.manualProcessingCancelled) return;
                    try {
                        const [tRes, cRes] = await Promise.all([
                            RUMIAPIManager.get(`/api/v2/tickets/${id}.json`),
                            // BUG-CMTPAG FIX: use paginated fetchAllComments
                            RUMIAPIManager.fetchAllComments(id)
                        ]);
                        const result = await RUMIProcessor.processTicketWithData(id, tRes.ticket, cRes || [], 'Manual', true);
                        processedCount++;
                        if (result.action !== 'none' && result.action !== 'skipped') actionCount++;
                    } catch (e) { processedCount++; RUMILogger.error('MONITOR', `Manual error ticket ${id}`, { error: e.message }); }
                }));
                if (progressCallback) progressCallback(processedCount, ticketIds.length);
                await new Promise(r => setTimeout(r, 150));
            }

            RUMILogger.isManualProcessing = false;
            RUMILogger.info('MONITOR', 'Manual processing complete', { processed: processedCount, actioned: actionCount });
            return { processed: processedCount, actioned: actionCount, cancelled: this.manualProcessingCancelled };
        }

        static async processView(viewId, viewName, progressCallback = null) {
            RUMILogger.isManualProcessing = true;
            // BUG-CACHE FIX: clear user role cache at start of each processView call
            RUMIProcessor._userRoleCache = new Map();
            RUMILogger.info('MONITOR', `Processing view "${viewName}"`, { viewId });
            try {
                if (progressCallback) progressCallback({ phase: 'fetching', current: 0, total: 0, viewName });

                // BUG-VPAG FIX: replace duplicated while-loop with shared helper
                const allTicketIds = await this.fetchViewTicketIds(viewId);

                if (progressCallback) progressCallback({ phase: 'fetching', current: allTicketIds.length, total: allTicketIds.length, viewName });

                if (!allTicketIds.length) return { fetched: 0, processed: 0, actioned: 0 };
                if (progressCallback) progressCallback({ phase: 'processing', current: 0, total: allTicketIds.length, viewName });

                let processedCount = 0, actionCount = 0, lastUpdateTime = 0;

                // BUG-02 FIX: replace unthrottled Promise.all with batches of 3 + 200ms delay
                // to avoid saturating the Zendesk rate limit during large view processing
                const BATCH_SIZE = 3;
                for (let i = 0; i < allTicketIds.length; i += BATCH_SIZE) {
                    const batch = allTicketIds.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(async id => {
                        try {
                            const [tRes, cRes] = await Promise.all([
                                RUMIAPIManager.get(`/api/v2/tickets/${id}.json`),
                                // BUG-CMTPAG FIX: use paginated fetchAllComments
                                RUMIAPIManager.fetchAllComments(id)
                            ]);
                            const result = await RUMIProcessor.processTicketWithData(id, tRes.ticket, cRes || [], viewName, true);
                            processedCount++;
                            const now = Date.now();
                            if (progressCallback && (now - lastUpdateTime > 500 || processedCount === allTicketIds.length)) {
                                lastUpdateTime = now;
                                progressCallback({ phase: 'processing', current: processedCount, total: allTicketIds.length, viewName });
                            }
                            if (result.action !== 'none' && result.action !== 'skipped') actionCount++;
                        } catch (e) {
                            processedCount++;
                            RUMILogger.error('MONITOR', `processView error ticket ${id}`, { error: e.message });
                        }
                    }));
                    if (i + BATCH_SIZE < allTicketIds.length) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                }

                RUMILogger.info('MONITOR', `View "${viewName}" processing complete`, { fetched: allTicketIds.length, actioned: actionCount });
                return { fetched: allTicketIds.length, processed: processedCount, actioned: actionCount };
            } finally {
                RUMILogger.isManualProcessing = false;
            }
        }
    }

    // ============================================================================
    // UI STYLES  (FIX: casablanca → morocco; added bikeDispute, egypt, careEscalations counters)
    // ============================================================================

    const CSS_STYLES = `
        :root {
            --rumi-bg: #F5F6F7;
            --rumi-panel-bg: #FFFFFF;
            --rumi-text: #111827;
            --rumi-text-secondary: #6B7280;
            --rumi-border: #E6E9EB;
            --rumi-accent-blue: #2563EB;
            --rumi-accent-green: #10B981;
            --rumi-accent-red: #EF4444;
            --rumi-accent-yellow: #F59E0B;
        }
        [data-theme="dark"] {
            --rumi-bg: #1F2937;
            --rumi-panel-bg: #111827;
            --rumi-text: #F9FAFB;
            --rumi-text-secondary: #D1D5DB;
            --rumi-border: #374151;
            --rumi-accent-blue: #3B82F6;
            --rumi-accent-green: #10B981;
            --rumi-accent-red: #EF4444;
            --rumi-accent-yellow: #F59E0B;
        }
        #rumi-root {
            position: fixed !important; inset: 0 !important; z-index: 2147483647 !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 14px; color: var(--rumi-text); background: var(--rumi-bg);
            display: flex !important; flex-direction: column; height: 100% !important; width: 100% !important; visibility: visible !important;
        }
        #rumi-topbar {
            height: 60px; min-height: 60px; background: var(--rumi-panel-bg);
            border-bottom: 1px solid var(--rumi-border); display: flex; align-items: center;
            justify-content: space-between; padding: 0 20px; flex-shrink: 0;
        }
        /* CHANGE-1-STEP-5: max-height keeps work area within one viewport */
        #rumi-main { display: flex; flex: 1; overflow: hidden; min-height: 0; max-height: calc(100vh - 60px); }
        /* CHANGE-1-STEP-2: prevent child content pushing past viewport width */
        .rumi-main-tab-panel { display: none; width: 100%; height: 100%; box-sizing: border-box; max-width: 100%; }
        .rumi-main-tab-panel.rumi-tab-visible { display: flex; flex: 1; overflow: hidden; }
        #rumi-main-management.rumi-tab-visible,
        #rumi-main-logs.rumi-tab-visible { overflow-y: auto; }
        /* CHANGE-1-STEP-1: settings tab scrolls internally, topbar/tabnav never scroll out */
        #rumi-main-settings.rumi-tab-visible {
            display: flex !important;
            flex-direction: column;
            flex: 1;
            overflow-y: auto;
            overflow-x: hidden;
            min-height: 0;
            max-height: 100%;
            width: 100%;
            box-sizing: border-box;
        }
        #rumi-left-panel, #rumi-left-panel-manual {
            width: 370px; min-width: 370px; flex-shrink: 0;
            background: var(--rumi-panel-bg); border-right: 1px solid var(--rumi-border);
            padding: 20px; overflow-y: auto; overflow-x: hidden; min-height: 0;
        }
        #rumi-work-area, #rumi-work-area-manual {
            flex: 1; padding: 20px; display: flex; flex-direction: column; overflow: hidden; min-width: 0; min-height: 0;
        }
        .rumi-btn { padding: 8px 16px; border-radius: 6px; border: none; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
        .rumi-btn-primary { background: var(--rumi-accent-blue); color: white; }
        .rumi-btn-primary:hover:not(:disabled) { opacity: 0.9; }
        .rumi-btn-secondary { background: var(--rumi-border); color: var(--rumi-text); }
        .rumi-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Cyber Toggle */
        .cyber-toggle-wrapper { display: inline-flex; flex-direction: column; align-items: center; position: relative; padding: 15px; }
        .cyber-toggle-checkbox { position: absolute; opacity: 0; width: 0; height: 0; }
        .cyber-toggle { position: relative; display: inline-block; width: 64px; height: 32px; cursor: pointer; }
        .cyber-toggle-track { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: #111; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 8px rgba(0,0,0,0.5), inset 0 0 4px rgba(0,0,0,0.8); transition: all 0.4s cubic-bezier(0.3,1.5,0.7,1); }
        .cyber-toggle-track::before { content: ""; position: absolute; inset: 2px; border-radius: 14px; background: #222; box-shadow: inset 0 0 5px rgba(0,0,0,0.5); z-index: 0; transition: all 0.4s ease; }
        .cyber-toggle-track-glow { position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: linear-gradient(90deg,#03e9f4,#4a00e0); opacity: 0; border-radius: 16px; z-index: 1; transition: all 0.4s ease; }
        .cyber-toggle-thumb { position: absolute; top: 4px; left: 4px; width: 24px; height: 24px; background: #151515; border-radius: 50%; z-index: 2; transition: all 0.4s cubic-bezier(0.3,1.5,0.7,1); box-shadow: 0 2px 5px rgba(0,0,0,0.4); }
        .cyber-toggle-thumb-shadow { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 30% 30%,rgba(255,255,255,0.1),transparent 70%); z-index: 1; }
        .cyber-toggle-thumb-highlight { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 70% 70%,rgba(0,0,0,0.2),transparent 70%); z-index: 1; }
        .cyber-toggle-thumb-icon { position: absolute; inset: 0; display: flex; justify-content: center; align-items: center; z-index: 2; opacity: 0.7; transition: opacity 0.4s ease, transform 0.4s ease; }
        .cyber-toggle-thumb-icon svg { width: 14px; height: 14px; fill: #555; transition: fill 0.4s ease; }
        .cyber-toggle-track-dots { position: absolute; top: 0; left: 0; width: 100%; height: 100%; display: flex; justify-content: flex-end; align-items: center; padding-right: 10px; z-index: 1; }
        .cyber-toggle-track-dot { width: 3px; height: 3px; border-radius: 50%; background: #444; margin-left: 3px; opacity: 0.5; transition: all 0.4s ease; }
        .cyber-toggle-particles { position: absolute; inset: 0; z-index: 0; overflow: hidden; pointer-events: none; }
        .cyber-toggle-particle { position: absolute; width: 3px; height: 3px; background: #03e9f4; border-radius: 50%; opacity: 0; filter: blur(1px); transition: all 0.3s ease; box-shadow: 0 0 4px rgba(3,233,244,0.8); }
        .cyber-toggle-particle:nth-child(1) { top: 15%; right: 20%; }
        .cyber-toggle-particle:nth-child(2) { top: 45%; right: 30%; }
        .cyber-toggle-particle:nth-child(3) { top: 25%; right: 40%; }
        .cyber-toggle-particle:nth-child(4) { top: 60%; right: 15%; }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-track-glow { opacity: 0.5; }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-thumb { left: calc(100% - 28px); background: #222; }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-thumb-icon { transform: rotate(360deg); }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-thumb-icon svg { fill: #03e9f4; }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-track-dot { background: #03e9f4; box-shadow: 0 0 4px #03e9f4; opacity: 1; }
        .cyber-toggle-checkbox:checked + .cyber-toggle .cyber-toggle-particle { opacity: 1; animation: cyber-toggle-float 3s infinite alternate; }
        @keyframes cyber-toggle-float { 0% { transform: translateY(0); } 50% { transform: translateY(-4px); } 100% { transform: translateY(0); } }

        .rumi-status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--rumi-accent-red); display: inline-block; margin-right: 6px; }
        .rumi-status-dot.rumi-monitoring { background: var(--rumi-accent-green); animation: rumi-pulse 2s infinite; }
        @keyframes rumi-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        @keyframes rumi-toast-in  { from { transform: translateY(100px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes rumi-toast-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(100px); opacity: 0; } }
        @keyframes rumi-spin { to { transform: rotate(360deg); } }

        .rumi-section-title { font-size: 16px; font-weight: 600; margin: 16px 0 8px 0; }
        .rumi-section-title:first-child { margin-top: 0; }
        .rumi-divider { margin: 24px 0; border: none; border-top: 1px solid var(--rumi-border); }
        .rumi-input-number { width: 60px; margin-left: 8px; padding: 4px 8px; border: 1px solid var(--rumi-border); border-radius: 4px; font-size: 14px; background: var(--rumi-panel-bg); color: var(--rumi-text); }
        .rumi-select { margin-left: 8px; padding: 4px 8px; border: 1px solid var(--rumi-border); border-radius: 4px; font-size: 14px; cursor: pointer; background: var(--rumi-panel-bg); color: var(--rumi-text); }
        .rumi-textarea { width: 100%; min-height: 100px; padding: 12px; border: 1px solid var(--rumi-border); border-radius: 4px; font-family: monospace; font-size: 13px; resize: vertical; background: var(--rumi-panel-bg); color: var(--rumi-text); }
        .rumi-status-text { font-size: 13px; color: var(--rumi-text-secondary); margin-top: 16px; }
        .rumi-button-group { display: flex; gap: 8px; margin-top: 16px; }

        /* Counter grid - 3 columns for more stats */
        .rumi-counters-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 12px; }
        .rumi-counter-card { background: var(--rumi-panel-bg); border: 2px solid var(--rumi-border); border-radius: 8px; padding: 10px 6px; text-align: center; transition: all 0.2s; }
        .rumi-counter-value { font-size: 22px; font-weight: 700; color: var(--rumi-text); margin-bottom: 3px; }
        .rumi-counter-label { font-size: 10px; color: var(--rumi-text-secondary); font-weight: 500; text-transform: uppercase; letter-spacing: 0.4px; }
        .rumi-counter-pending      { border-color: #1f73b7; }
        .rumi-counter-solved       { border-color: #5c6970; }
        .rumi-counter-care         { border-color: #EF4444; }
        .rumi-counter-hala         { border-color: #8B5CF6; }
        .rumi-counter-morocco      { border-color: #06B6D4; }
        .rumi-counter-egypt        { border-color: #D97706; }
        .rumi-counter-bikeDispute  { border-color: #F59E0B; }
        .rumi-counter-careEscalations { border-color: #9333EA; }

        .rumi-tabs-nav { display: flex; gap: 4px; border-bottom: 2px solid var(--rumi-border); margin-bottom: 0; overflow-x: auto; flex-shrink: 0; }
        .rumi-tab-btn { padding: 10px 14px; border: none; background: transparent; color: var(--rumi-text-secondary); font-size: 12px; font-weight: 500; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.2s; white-space: nowrap; }
        .rumi-tab-btn:hover { color: var(--rumi-text); background: var(--rumi-bg); }
        .rumi-tab-btn.active { color: var(--rumi-accent-blue); border-bottom-color: var(--rumi-accent-blue); font-weight: 600; }
        #rumi-work-area .rumi-tabs-nav, #rumi-work-area-manual .rumi-tabs-nav { margin-bottom: 16px; }

        .rumi-tab-content { flex: 1; overflow: auto; min-height: 0; display: flex; flex-direction: column; }
        .rumi-tab-panel { display: none; }
        .rumi-tab-panel.active { display: flex; flex-direction: column; flex: 1; min-height: 0; }
        .rumi-table-container { overflow: visible; }

        .rumi-table { width: 100%; border-collapse: collapse; font-size: 12px; }
        .rumi-table thead { position: sticky; top: 0; z-index: 10; background: var(--rumi-panel-bg); }
        .rumi-table th { text-align: left; padding: 10px 12px; border-bottom: 2px solid var(--rumi-border); border-right: 1px solid var(--rumi-border); font-weight: 600; font-size: 11px; text-transform: uppercase; color: var(--rumi-text-secondary); letter-spacing: 0.5px; background: var(--rumi-panel-bg); white-space: nowrap; }
        .rumi-table td { padding: 10px 12px; border-bottom: 1px solid var(--rumi-border); border-right: 1px solid var(--rumi-border); color: var(--rumi-text); white-space: nowrap; }
        .rumi-table td a { color: var(--rumi-accent-blue); text-decoration: none; }
        .rumi-table td a:hover { text-decoration: underline; }
        .rumi-table tbody tr { background: var(--rumi-panel-bg); }
        .rumi-table tbody tr:hover { background: var(--rumi-bg); }
        [data-theme="light"] .rumi-table tbody tr.rumi-dry-run { background: #FEF2F2 !important; }
        [data-theme="dark"]  .rumi-table tbody tr.rumi-dry-run { background: rgba(239,68,68,0.15) !important; }

        .rumi-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        .rumi-badge-yes { background: #D1FAE5; color: #059669; }
        .rumi-badge-no  { background: #FEE2E2; color: #DC2626; }
        [data-theme="light"] .rumi-badge-pending        { background: #1f73b7; color: #fff; }
        [data-theme="dark"]  .rumi-badge-pending        { background: #2693d6; color: #151a1e; }
        [data-theme="light"] .rumi-badge-solved         { background: #5c6970; color: #fff; }
        [data-theme="dark"]  .rumi-badge-solved         { background: #9CA3AF; color: #151a1e; }
        [data-theme="light"] .rumi-badge-care           { background: #DC2626; color: #fff; }
        [data-theme="dark"]  .rumi-badge-care           { background: #EF4444; color: #151a1e; }
        [data-theme="light"] .rumi-badge-hala           { background: #7C3AED; color: #fff; }
        [data-theme="dark"]  .rumi-badge-hala           { background: #A78BFA; color: #151a1e; }
        [data-theme="light"] .rumi-badge-morocco        { background: #0891B2; color: #fff; }
        [data-theme="dark"]  .rumi-badge-morocco        { background: #22D3EE; color: #151a1e; }
        [data-theme="light"] .rumi-badge-egypt          { background: #D97706; color: #fff; }
        [data-theme="dark"]  .rumi-badge-egypt          { background: #FBBF24; color: #151a1e; }
        [data-theme="light"] .rumi-badge-careEscalations{ background: #9333EA; color: #fff; }
        [data-theme="dark"]  .rumi-badge-careEscalations{ background: #C084FC; color: #151a1e; }
        [data-theme="light"] .rumi-badge-bikeDispute    { background: #D97706; color: #fff; }
        [data-theme="dark"]  .rumi-badge-bikeDispute    { background: #FCD34D; color: #151a1e; }
        [data-theme="light"] .rumi-badge-none           { background: #9CA3AF; color: #1F2937; }
        [data-theme="dark"]  .rumi-badge-none           { background: #6B7280; color: #F3F4F6; }
        [data-theme="light"] .rumi-badge-skipped        { background: #E5E7EB; color: #4B5563; }
        [data-theme="dark"]  .rumi-badge-skipped        { background: #374151; color: #D1D5DB; }

        .rumi-status-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
        [data-theme="light"] .rumi-status-badge-new     { background: #fca347; color: #4c2c17; }
        [data-theme="dark"]  .rumi-status-badge-new     { background: #e38215; color: #151a1e; }
        [data-theme="light"] .rumi-status-badge-open    { background: #cd3642; color: #fff; }
        [data-theme="dark"]  .rumi-status-badge-open    { background: #eb5c69; color: #151a1e; }
        [data-theme="light"] .rumi-status-badge-pending { background: #1f73b7; color: #fff; }
        [data-theme="dark"]  .rumi-status-badge-pending { background: #2693d6; color: #151a1e; }
        [data-theme="light"] .rumi-status-badge-solved  { background: #5c6970; color: #fff; }
        [data-theme="dark"]  .rumi-status-badge-solved  { background: #b0b8be; color: #151a1e; }

        .rumi-logs-container { max-height: calc(100vh - 220px); overflow-y: auto; }
        .rumi-log-entry { padding: 8px 12px; margin: 4px 0; border-radius: 4px; background: var(--rumi-panel-bg); font-family: 'Courier New', monospace; font-size: 12px; border-left: 3px solid transparent; }
        .rumi-log-entry.rumi-error { border-left-color: var(--rumi-accent-red); }
        .rumi-log-entry.rumi-warn  { border-left-color: var(--rumi-accent-yellow); }
        .rumi-log-entry.rumi-info  { border-left-color: var(--rumi-accent-blue); }
        .rumi-log-entry.rumi-debug { border-left-color: var(--rumi-text-secondary); background: var(--rumi-bg); }
        .rumi-log-meta { margin-top: 4px; font-size: 11px; color: var(--rumi-text-secondary); }

        .rumi-pin-input-group { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
        .rumi-pin-input { width: 100%; padding: 8px; border: 1px solid var(--rumi-border); border-radius: 4px; font-size: 13px; box-sizing: border-box; background: var(--rumi-panel-bg); color: var(--rumi-text); }
        .rumi-pin-radio-group { display: flex; gap: 16px; padding: 8px 0; }
        .rumi-pin-radio-label { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; }
        .rumi-pinned-list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
        .rumi-pinned-item { padding: 10px; background: var(--rumi-bg); border: 1px solid var(--rumi-border); border-radius: 6px; font-size: 12px; }
        .rumi-pinned-item-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .rumi-pinned-item-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
        .rumi-pinned-badge-blocked { background: #FEE2E2; color: #DC2626; }
        .rumi-pinned-badge-care-active { background: #DBEAFE; color: #1D4ED8; }
        .rumi-pinned-badge-care-changed { background: #FEF3C7; color: #D97706; }
        .rumi-pinned-item-remove { padding: 2px 8px; background: transparent; border: 1px solid var(--rumi-border); border-radius: 4px; cursor: pointer; font-size: 11px; color: var(--rumi-text-secondary); transition: all 0.2s; }
        .rumi-pinned-item-remove:hover { background: var(--rumi-accent-red); color: white; border-color: var(--rumi-accent-red); }
        .rumi-pinned-item-info { display: flex; flex-direction: column; gap: 4px; color: var(--rumi-text-secondary); }
        .rumi-pinned-item-link { color: var(--rumi-accent-blue); text-decoration: none; font-weight: 600; }
        .rumi-pinned-empty { padding: 20px; text-align: center; color: var(--rumi-text-secondary); font-size: 12px; background: var(--rumi-bg); border-radius: 6px; margin-top: 12px; }

        .rumi-toggle-switch { position: relative; width: 44px; height: 24px; flex-shrink: 0; }
        .rumi-toggle-switch input { opacity: 0; width: 0; height: 0; }
        .rumi-toggle-slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #D1D5DB; transition: 0.3s; border-radius: 24px; }
        .rumi-toggle-slider:before { position: absolute; content: ""; height: 18px; width: 18px; left: 3px; bottom: 3px; background-color: white; transition: 0.3s; border-radius: 50%; }
        .rumi-toggle-switch input:checked + .rumi-toggle-slider { background-color: var(--rumi-accent-blue); }
        .rumi-toggle-switch input:checked + .rumi-toggle-slider:before { transform: translateX(20px); }

        .rumi-export-dropdown { position: relative; display: inline-block; width: 100%; margin-top: 8px; }
        .rumi-export-btn { width: 100%; padding: 4px 8px; font-size: 11px; background: var(--rumi-accent-blue); color: white; border: none; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; font-weight: 500; transition: all 0.2s; }
        .rumi-export-btn:hover { opacity: 0.9; }
        .rumi-export-menu { position: absolute; bottom: 100%; left: 0; right: 0; background: var(--rumi-panel-bg); border: 1px solid var(--rumi-border); border-radius: 6px; box-shadow: 0 -4px 12px rgba(0,0,0,0.15); margin-bottom: 4px; opacity: 0; visibility: hidden; transform: translateY(10px); transition: all 0.2s ease; z-index: 1000; overflow: hidden; }
        .rumi-export-dropdown.active .rumi-export-menu { opacity: 1; visibility: visible; transform: translateY(0); }
        .rumi-export-option { padding: 10px 12px; cursor: pointer; transition: all 0.15s; border-bottom: 1px solid var(--rumi-border); font-size: 12px; font-weight: 500; color: var(--rumi-text); display: flex; align-items: center; gap: 8px; }
        .rumi-export-option:last-child { border-bottom: none; }
        .rumi-export-option:hover { background: var(--rumi-bg); color: var(--rumi-accent-blue); }

        .rumi-view-process-btn { padding: 8px 12px; border: 1px solid var(--rumi-border); border-radius: 6px; background: var(--rumi-panel-bg); color: var(--rumi-text); font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.2s; text-align: left; width: 100%; }
        .rumi-view-process-btn:hover:not(:disabled) { background: var(--rumi-bg); border-color: var(--rumi-accent-blue); color: var(--rumi-accent-blue); }
        .rumi-view-process-btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* Settings tab — trigger phrase manager */
        .rumi-settings-section { background: var(--rumi-panel-bg); border: 1px solid var(--rumi-border); border-radius: 8px; padding: 20px; margin-bottom: 20px; }
        .rumi-settings-section-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: var(--rumi-text); }
        /* CHANGE-1-STEP-4: prevent long trigger phrases from overflowing horizontally */
        .rumi-settings-item { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border: 1px solid var(--rumi-border); border-radius: 6px; margin-bottom: 6px; transition: all 0.2s; max-width: 100%; box-sizing: border-box; word-break: break-word; }
        .rumi-settings-item:hover { background: var(--rumi-bg); }
        .rumi-settings-item-label { font-size: 12px; color: var(--rumi-text); flex: 1; word-break: break-word; margin-right: 12px; }
        .rumi-settings-sub-tabs { display: flex; gap: 8px; margin-bottom: 20px; border-bottom: 2px solid var(--rumi-border); flex-wrap: wrap; }
        .rumi-settings-sub-tab { padding: 10px 20px; border: none; background: transparent; color: var(--rumi-text-secondary); font-size: 14px; font-weight: 500; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.2s; }
        .rumi-settings-sub-tab.active { color: var(--rumi-accent-blue); border-bottom-color: var(--rumi-accent-blue); font-weight: 600; }
        .rumi-settings-sub-content { display: none; }
        .rumi-settings-sub-content.active { display: block; }
        .rumi-btn-sm { padding: 6px 12px; font-size: 12px; border-radius: 4px; border: 1px solid var(--rumi-border); background: var(--rumi-panel-bg); color: var(--rumi-text); cursor: pointer; transition: all 0.2s; font-weight: 500; }
        .rumi-btn-sm:hover:not(:disabled) { background: var(--rumi-bg); border-color: var(--rumi-accent-blue); color: var(--rumi-accent-blue); }

        input[type="text"], input[type="number"] { background: var(--rumi-panel-bg); color: var(--rumi-text); border: 1px solid var(--rumi-border); }
        input[type="checkbox"], input[type="radio"] { accent-color: var(--rumi-accent-blue); }
        select option { background: var(--rumi-panel-bg); color: var(--rumi-text); }
    `;

    // ============================================================================
    // CYBER TOGGLE HTML HELPER
    // ============================================================================
    function cyberToggle(id, label = '') {
        return `<div class="cyber-toggle-wrapper" style="padding:0;">
            <input type="checkbox" class="cyber-toggle-checkbox" id="${id}" />
            <label for="${id}" class="cyber-toggle">
                <div class="cyber-toggle-track">
                    <div class="cyber-toggle-track-glow"></div>
                    <div class="cyber-toggle-track-dots">
                        <span class="cyber-toggle-track-dot"></span>
                        <span class="cyber-toggle-track-dot"></span>
                        <span class="cyber-toggle-track-dot"></span>
                    </div>
                </div>
                <div class="cyber-toggle-thumb">
                    <div class="cyber-toggle-thumb-shadow"></div>
                    <div class="cyber-toggle-thumb-highlight"></div>
                    <div class="cyber-toggle-thumb-icon"><svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg></div>
                </div>
                <div class="cyber-toggle-particles">
                    <span class="cyber-toggle-particle"></span><span class="cyber-toggle-particle"></span>
                    <span class="cyber-toggle-particle"></span><span class="cyber-toggle-particle"></span>
                </div>
            </label>${label ? `<span style="font-weight:600;color:var(--rumi-accent-red);margin-left:8px;">${label}</span>` : ''}
        </div>`;
    }

    // ── Counter card html ──────────────────────────────────────────────────────
    function counterCard(id, label, cls) {
        return `<div class="rumi-counter-card ${cls}">
            <div class="rumi-counter-value" id="${id}">0</div>
            <div class="rumi-counter-label">${label}</div>
        </div>`;
    }

    // ── Table html ─────────────────────────────────────────────────────────────
    // NOTE: Keep this in sync with `renderTicketsTable()` column order.
    const TABLE_HEADERS = `<tr>${[
        'PQMS', '#', 'Ticket ID', 'Subject', 'View', 'Action', 'Trigger',
        'Prev Status', 'New Status', 'Prev Group', 'New Group', 'Processed At',
        'Dry Run', 'Updated?'
    ].map(h => `<th>${h}</th>`).join('')}</tr>`;

    function tablePanel(panelId, tbodyId) {
        return `<div id="${panelId}" class="rumi-tab-panel">
            <div class="rumi-table-container">
                <table class="rumi-table">
                    <thead>${TABLE_HEADERS}</thead>
                    <tbody id="${tbodyId}"></tbody>
                </table>
            </div>
        </div>`;
    }

    // ============================================================================
    // HTML TEMPLATE  (FIX: Settings tab now has its own content; Morocco everywhere)
    // ============================================================================

    const HTML_TEMPLATE = `
        <div id="rumi-root" data-theme="dark">
            <div id="rumi-topbar">
                <div>
                    <h1 style="margin:0;font-size:18px;">RUMI Automation Tool</h1>
                    <small style="color:var(--rumi-text-secondary);">v2.1.0 — Ticket Processing & Business Logic</small>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                    <span class="rumi-status-dot" id="rumi-status-dot"></span>
                    <span id="rumi-status-text">Offline</span>
                </div>
                <div style="display:flex;gap:8px;align-items:center;">
                    <div style="transform:scale(0.8);transform-origin:left center;">
                        ${cyberToggle('rumi-dry-run-global', 'DRY RUN MODE')}
                    </div>
                    <button id="rumi-btn-monitor-toggle" class="rumi-btn rumi-btn-primary">Start Monitoring</button>
                    <button id="rumi-btn-theme" class="rumi-btn rumi-btn-secondary" style="padding:6px 10px;font-size:11px;">🌙 Theme</button>
                </div>
            </div>

            <div class="rumi-tabs-nav" style="background:var(--rumi-panel-bg);border-bottom:2px solid var(--rumi-border);padding:0 20px;justify-content:space-between;">
                <div style="display:flex;gap:4px;">
                    <button class="rumi-tab-btn active" data-main-tab="automatic">Automatic</button>
                    <button class="rumi-tab-btn" data-main-tab="manual">Manual</button>
                    <button class="rumi-tab-btn" data-main-tab="management">Management</button>
                    <button class="rumi-tab-btn" data-main-tab="logs">Logs</button>
                </div>
                <button class="rumi-tab-btn" data-main-tab="settings">⚙ Settings</button>
            </div>

            <div id="rumi-main">

                <!-- ═══ AUTOMATIC TAB ═══ -->
                <div id="rumi-main-automatic" class="rumi-main-tab-panel rumi-tab-visible">
                    <div id="rumi-left-panel">
                        <h2 class="rumi-section-title">Select Views to Monitor</h2>
                        <div id="rumi-views-list"></div>
                        <div class="rumi-button-group">
                            <button id="rumi-select-all" class="rumi-btn rumi-btn-secondary" style="font-size:12px;padding:6px 12px;">Select All</button>
                            <button id="rumi-clear-all" class="rumi-btn rumi-btn-secondary" style="font-size:12px;padding:6px 12px;">Clear All</button>
                        </div>
                        <hr class="rumi-divider">
                        <h2 class="rumi-section-title">Monitoring</h2>
                        <label style="display:block;margin:12px 0 8px 0;">Interval (seconds): <input type="number" id="rumi-interval" class="rumi-input-number" min="15" max="60" value="30"></label>
                        <p id="rumi-monitor-status" class="rumi-status-text">Not monitoring</p>
                        <p id="rumi-last-run" class="rumi-status-text">Last run: Never</p>
                        <hr class="rumi-divider">
                        <h2 class="rumi-section-title">Counters</h2>
                        <div class="rumi-counters-grid">
                            ${counterCard('rumi-counter-total', 'Total', '')}
                            ${counterCard('rumi-counter-pending', 'Pending', 'rumi-counter-pending')}
                            ${counterCard('rumi-counter-solved', 'Solved', 'rumi-counter-solved')}
                            ${counterCard('rumi-counter-care', 'Care', 'rumi-counter-care')}
                            ${counterCard('rumi-counter-hala', 'Hala/RTA', 'rumi-counter-hala')}
                            ${counterCard('rumi-counter-morocco', 'Morocco', 'rumi-counter-morocco')}
                            ${counterCard('rumi-counter-egypt', 'Egypt', 'rumi-counter-egypt')}
                            ${counterCard('rumi-counter-bikeDispute', 'Bike Dispute', 'rumi-counter-bikeDispute')}
                            ${counterCard('rumi-counter-careEscalations', 'Escalations', 'rumi-counter-careEscalations')}
                        </div>
                        <button id="rumi-reset-counters" class="rumi-btn rumi-btn-secondary" style="width:100%;margin-top:8px;font-size:11px;padding:4px 8px;">Clear Data</button>
                        <div class="rumi-export-dropdown" id="rumi-export-dropdown-auto">
                            <button class="rumi-export-btn" id="rumi-export-btn-auto">⬇ Export Data ▼</button>
                            <div class="rumi-export-menu">
                                <div class="rumi-export-option" data-export-type="csv"  data-tab="auto">📄 Export as CSV</div>
                                <div class="rumi-export-option" data-export-type="html" data-tab="auto">🌐 Export as HTML</div>
                            </div>
                        </div>
                        <hr class="rumi-divider">
                        <h2 class="rumi-section-title">Pinned Tickets</h2>
                        <div class="rumi-pin-input-group">
                            <input type="text" id="rumi-pin-ticket-id" class="rumi-pin-input" placeholder="Enter Ticket ID">
                            <div class="rumi-pin-radio-group">
                                <label class="rumi-pin-radio-label"><input type="radio" name="rumi-pin-type" value="blocked" checked> Block Processing</label>
                                <label class="rumi-pin-radio-label"><input type="radio" name="rumi-pin-type" value="care_routing"> Care Routing</label>
                            </div>
                            <button id="rumi-add-pin" class="rumi-btn rumi-btn-primary" style="font-size:12px;padding:6px 12px;">Add Pin</button>
                        </div>
                        <div id="rumi-pinned-list" class="rumi-pinned-list"></div>
                    </div>
                    <div id="rumi-work-area">
                        <div class="rumi-tabs-nav">
                            <button class="rumi-tab-btn active" data-auto-tab="all">All (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="pending">Pending (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="solved">Solved (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="care">Care (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="hala">Hala (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="morocco">Morocco (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="egypt">Egypt (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="bikeDispute">Bike (0)</button>
                            <button class="rumi-tab-btn" data-auto-tab="careEscalations">Escalations (0)</button>
                        </div>
                        <div class="rumi-tab-content">
                            ${tablePanel('rumi-tab-all', 'rumi-table-all')}
                            ${tablePanel('rumi-tab-pending', 'rumi-table-pending')}
                            ${tablePanel('rumi-tab-solved', 'rumi-table-solved')}
                            ${tablePanel('rumi-tab-care', 'rumi-table-care')}
                            ${tablePanel('rumi-tab-hala', 'rumi-table-hala')}
                            ${tablePanel('rumi-tab-morocco', 'rumi-table-morocco')}
                            ${tablePanel('rumi-tab-egypt', 'rumi-table-egypt')}
                            ${tablePanel('rumi-tab-bikeDispute', 'rumi-table-bikeDispute')}
                            ${tablePanel('rumi-tab-careEscalations', 'rumi-table-careEscalations')}
                        </div>
                    </div>
                </div>

                <!-- ═══ MANUAL TAB ═══ -->
                <div id="rumi-main-manual" class="rumi-main-tab-panel">
                    <div id="rumi-left-panel-manual">
                        <h2 class="rumi-section-title">Manual Processing</h2>
                        <textarea id="rumi-manual-ids" class="rumi-textarea" placeholder="Enter ticket IDs (comma-separated)&#10;Example: 12345, 67890, 54321"></textarea>
                        <div id="rumi-ticket-count" style="margin-top:8px;font-size:13px;color:var(--rumi-text-secondary);font-weight:500;"><span id="rumi-ticket-count-value">0</span> tickets ready</div>
                        <div id="rumi-manual-progress" style="display:none;margin-top:8px;padding:8px;background:var(--rumi-bg);border-radius:4px;text-align:center;font-weight:600;color:var(--rumi-accent-blue);font-size:12px;">Processing 0/0...</div>
                        <div style="margin-top:12px;transform:scale(0.8);transform-origin:left center;">
                            ${cyberToggle('rumi-manual-dry-run', 'DRY RUN MODE')}
                        </div>
                        <button id="rumi-manual-process" class="rumi-btn rumi-btn-primary" style="width:100%;margin-top:12px;">Process Tickets</button>
                        <hr class="rumi-divider">
                        <h2 class="rumi-section-title">Process View</h2>
                        <div style="font-size:12px;color:var(--rumi-text-secondary);margin-bottom:12px;">Click a view to process all its tickets</div>
                        <div id="rumi-view-buttons-container" style="display:flex;flex-direction:column;gap:6px;"></div>
                        <hr class="rumi-divider">
                        <h2 class="rumi-section-title">Counters</h2>
                        <div class="rumi-counters-grid">
                            ${counterCard('rumi-manual-counter-total', 'Total', '')}
                            ${counterCard('rumi-manual-counter-pending', 'Pending', 'rumi-counter-pending')}
                            ${counterCard('rumi-manual-counter-solved', 'Solved', 'rumi-counter-solved')}
                            ${counterCard('rumi-manual-counter-care', 'Care', 'rumi-counter-care')}
                            ${counterCard('rumi-manual-counter-hala', 'Hala/RTA', 'rumi-counter-hala')}
                            ${counterCard('rumi-manual-counter-morocco', 'Morocco', 'rumi-counter-morocco')}
                            ${counterCard('rumi-manual-counter-egypt', 'Egypt', 'rumi-counter-egypt')}
                            ${counterCard('rumi-manual-counter-bikeDispute', 'Bike Dispute', 'rumi-counter-bikeDispute')}
                            ${counterCard('rumi-manual-counter-careEscalations', 'Escalations', 'rumi-counter-careEscalations')}
                        </div>
                        <button id="rumi-reset-manual-counters" class="rumi-btn rumi-btn-secondary" style="width:100%;margin-top:8px;font-size:11px;padding:4px 8px;">Clear Data</button>
                        <div class="rumi-export-dropdown" id="rumi-export-dropdown-manual">
                            <button class="rumi-export-btn" id="rumi-export-btn-manual">⬇ Export Data ▼</button>
                            <div class="rumi-export-menu">
                                <div class="rumi-export-option" data-export-type="csv"  data-tab="manual">📄 Export as CSV</div>
                                <div class="rumi-export-option" data-export-type="html" data-tab="manual">🌐 Export as HTML</div>
                            </div>
                        </div>
                    </div>
                    <div id="rumi-work-area-manual">
                        <div class="rumi-tabs-nav">
                            <button class="rumi-tab-btn active" data-manual-tab="manual-all">All (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-pending">Pending (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-solved">Solved (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-care">Care (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-hala">Hala (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-morocco">Morocco (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-egypt">Egypt (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-bikeDispute">Bike (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-careEscalations">Escalations (0)</button>
                            <button class="rumi-tab-btn" data-manual-tab="manual-unprocessed">Unprocessed (0)</button>
                        </div>
                        <div class="rumi-tab-content">
                            ${tablePanel('rumi-manual-tab-all', 'rumi-manual-table-all')}
                            ${tablePanel('rumi-manual-tab-pending', 'rumi-manual-table-pending')}
                            ${tablePanel('rumi-manual-tab-solved', 'rumi-manual-table-solved')}
                            ${tablePanel('rumi-manual-tab-care', 'rumi-manual-table-care')}
                            ${tablePanel('rumi-manual-tab-hala', 'rumi-manual-table-hala')}
                            ${tablePanel('rumi-manual-tab-morocco', 'rumi-manual-table-morocco')}
                            ${tablePanel('rumi-manual-tab-egypt', 'rumi-manual-table-egypt')}
                            ${tablePanel('rumi-manual-tab-bikeDispute', 'rumi-manual-table-bikeDispute')}
                            ${tablePanel('rumi-manual-tab-careEscalations', 'rumi-manual-table-careEscalations')}
                            ${tablePanel('rumi-manual-tab-unprocessed', 'rumi-manual-table-unprocessed')}
                        </div>
                    </div>
                </div>

                <!-- ═══ MANAGEMENT TAB ═══ -->
                <div id="rumi-main-management" class="rumi-main-tab-panel">
                    <div style="flex:1;padding:30px;overflow-y:auto;">
                        <h2 class="rumi-section-title">Automation Management</h2>
                        <p style="margin-bottom:24px;color:var(--rumi-text-secondary);">Control routing and automation behavior.</p>

                        <div style="background:var(--rumi-panel-bg);border:1px solid var(--rumi-border);border-radius:8px;padding:24px;margin-bottom:24px;">
                            <h3 style="margin:0 0 16px 0;font-size:16px;font-weight:600;">Market Routing</h3>
                            <div id="rumi-mgmt-routing-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;"></div>
                        </div>

                        <div style="background:var(--rumi-panel-bg);border:1px solid var(--rumi-border);border-radius:8px;padding:24px;margin-bottom:24px;">
                            <h3 style="margin:0 0 16px 0;font-size:16px;font-weight:600;">Status Automation</h3>
                            <div id="rumi-mgmt-status-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px;"></div>
                        </div>

                        <div style="background:var(--rumi-panel-bg);border:1px solid var(--rumi-border);border-radius:8px;padding:24px;margin-bottom:24px;">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
                                <h3 style="margin:0;font-size:16px;font-weight:600;">PQMS Integration</h3>
                                ${cyberToggle('toggle-pqms-integration')}
                            </div>
                            <div style="margin-bottom:16px;">
                                <label style="display:block;margin-bottom:8px;font-weight:600;">OPS User:</label>
                                <select id="rumi-pqms-user-select" class="rumi-select" style="width:100%;max-width:400px;margin-left:0;">
                                    <option value="">-- Select OPS User --</option>
                                    <option value="32951">Bader Alzoubi (32951)</option>
                                    <option value="37862">Husam Ahmad Ibrahim Alnajy (37862)</option>
                                    <option value="48461">Mohammed Karout (48461)</option>
                                    <option value="51049">Zaid Bani Hani (51049)</option>
                                </select>
                            </div>
                            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
                                <div style="padding:16px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:8px;text-align:center;">
                                    <div style="font-size:28px;font-weight:700;color:var(--rumi-accent-blue);" id="rumi-pqms-total-count">0</div>
                                    <div style="font-size:12px;color:var(--rumi-text-secondary);margin-top:4px;">Total Submissions</div>
                                </div>
                                <div style="padding:16px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:8px;text-align:center;">
                                    <div style="font-size:28px;font-weight:700;color:var(--rumi-accent-green);" id="rumi-pqms-solved-count">0</div>
                                    <div style="font-size:12px;color:var(--rumi-text-secondary);margin-top:4px;">Solved</div>
                                </div>
                                <div style="padding:16px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:8px;text-align:center;">
                                    <div style="font-size:28px;font-weight:700;color:var(--rumi-accent-yellow);" id="rumi-pqms-pending-count">0</div>
                                    <div style="font-size:12px;color:var(--rumi-text-secondary);margin-top:4px;">Pending</div>
                                </div>
                            </div>
                            <div>
                                <label style="display:block;margin-bottom:8px;font-weight:500;">Submit to PQMS for:</label>
                                <select id="rumi-mgmt-pqms-option" class="rumi-select" style="margin-left:0;">
                                    <option value="solved">Solved Only</option>
                                    <option value="pending">Pending Only</option>
                                    <option value="both">Both Solved & Pending</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- ═══ LOGS TAB ═══ -->
                <div id="rumi-main-logs" class="rumi-main-tab-panel">
                    <div style="padding:20px;overflow-y:auto;flex:1;">
                        <div style="margin-bottom:16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                            <label>Filter:
                                <select id="rumi-log-filter" class="rumi-select">
                                    <option value="all">All</option>
                                    <option value="info">Info</option>
                                    <option value="warn">Warn</option>
                                    <option value="error">Error</option>
                                    <option value="debug">Debug</option>
                                </select>
                            </label>
                            <button id="rumi-download-logs" class="rumi-btn rumi-btn-primary" style="font-size:12px;padding:6px 12px;">⬇ Download Logs</button>
                            <button id="rumi-clear-logs" class="rumi-btn rumi-btn-secondary" style="font-size:12px;padding:6px 12px;">🗑 Clear Logs</button>
                        </div>
                        <div id="rumi-logs-container" class="rumi-logs-container"></div>
                    </div>
                </div>

                <!-- ═══ SETTINGS TAB — Two-level navigation ═══ -->
                <div id="rumi-main-settings" class="rumi-main-tab-panel">
                  <div style="padding:20px;width:100%;max-width:100%;box-sizing:border-box;overflow-x:hidden;flex:1;overflow-y:auto;">

                    <!-- LEVEL 1: Landing -->
                    <div id="rumi-settings-landing">
                      <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:700;">Settings</h2>
                      <p style="color:var(--rumi-text-secondary);margin:0 0 28px 0;font-size:14px;">Manage your automation configuration and account details.</p>
                      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;max-width:680px;">

                        <div id="rumi-settings-card-triggers" style="cursor:pointer;background:var(--rumi-panel-bg);border:1.5px solid var(--rumi-border);border-radius:12px;padding:28px 24px;transition:all 0.2s;display:flex;flex-direction:column;gap:12px;">
                          <div style="color:var(--rumi-accent-blue);font-size:28px;">☆</div>
                          <div>
                            <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Actions and Triggers</div>
                            <div style="font-size:13px;color:var(--rumi-text-secondary);line-height:1.5;">Configure automatic and manual action types, trigger phrases, and routing settings for ticket automation.</div>
                          </div>
                        </div>

                        <div id="rumi-settings-card-account" style="cursor:pointer;background:var(--rumi-panel-bg);border:1.5px solid var(--rumi-border);border-radius:12px;padding:28px 24px;transition:all 0.2s;display:flex;flex-direction:column;gap:12px;">
                          <div style="color:var(--rumi-accent-blue);font-size:28px;">👤</div>
                          <div>
                            <div style="font-size:16px;font-weight:700;margin-bottom:6px;">Account &amp; Permissions</div>
                            <div style="font-size:13px;color:var(--rumi-text-secondary);line-height:1.5;">View current user information, role, and account details.</div>
                          </div>
                        </div>

                      </div>
                    </div>

                    <!-- LEVEL 2: Triggers Section -->
                    <div id="rumi-settings-section-triggers" style="display:none;">
                      <button id="rumi-settings-back-triggers" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;margin-bottom:20px;background:transparent;border:1px solid var(--rumi-border);border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;color:var(--rumi-text);">← Back</button>
                      <h2 style="margin:0 0 6px 0;font-size:18px;font-weight:700;">Actions and Triggers</h2>
                      <p style="color:var(--rumi-text-secondary);margin:0 0 20px 0;font-size:13px;">Enable or disable individual trigger phrases for Automatic and Manual modes.</p>

                      <div class="rumi-settings-sub-tabs">
                        <button class="rumi-settings-sub-tab active" data-settings-mode="automatic">Automatic Mode</button>
                        <button class="rumi-settings-sub-tab" data-settings-mode="manual">Manual Mode</button>
                      </div>
                      <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;">
                        <button id="rumi-settings-enable-all" class="rumi-btn rumi-btn-primary" style="font-size:12px;padding:6px 14px;">Enable All</button>
                        <button id="rumi-settings-disable-all" class="rumi-btn rumi-btn-secondary" style="font-size:12px;padding:6px 14px;">Disable All</button>
                        <button id="rumi-settings-invert-all" class="rumi-btn rumi-btn-secondary" style="font-size:12px;padding:6px 14px;">Invert All</button>
                      </div>
                      <div id="rumi-settings-content"></div>
                    </div>

                    <!-- LEVEL 2: Account Section -->
                    <div id="rumi-settings-section-account" style="display:none;">
                      <button id="rumi-settings-back-account" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;margin-bottom:20px;background:transparent;border:1px solid var(--rumi-border);border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;color:var(--rumi-text);">← Back</button>
                      <h2 style="margin:0 0 6px 0;font-size:18px;font-weight:700;">Account &amp; Permissions</h2>
                      <p style="color:var(--rumi-text-secondary);margin:0 0 20px 0;font-size:13px;">Your current Zendesk session and account details.</p>
                      <div id="rumi-settings-user-info"></div>
                    </div>

                  </div>
                </div>

            </div>
        </div>
    `;

    // ============================================================================
    // UI CLASS
    // ============================================================================

    class RUMIUI {
        static viewsMap = new Map();
        static viewIdToNameMap = new Map();
        static logRenderScheduled = false;
        static lastRenderedLogTimestamp = null;
        static currentLogFilter = 'all';
        static currentAutoTab = 'all';
        static currentManualTab = 'manual-all';
        static currentSettingsMode = 'automatic';   // FIX: track settings mode

        // All auto action tabs and their filter predicate
        static AUTO_TABS = [
            { key: 'all', label: 'All', filter: () => true },
            { key: 'pending', label: 'Pending', filter: t => t.action === 'pending' },
            { key: 'solved', label: 'Solved', filter: t => t.action === 'solved' },
            { key: 'care', label: 'Care', filter: t => t.action === 'care' },
            { key: 'hala', label: 'Hala', filter: t => t.action === 'hala' },
            { key: 'morocco', label: 'Morocco', filter: t => t.action === 'morocco' },
            { key: 'egypt', label: 'Egypt', filter: t => t.action === 'egypt' },
            { key: 'bikeDispute', label: 'Bike', filter: t => t.action === 'bikeDispute' },
            { key: 'careEscalations', label: 'Escalations', filter: t => t.action === 'careEscalations' },
        ];

        static MANUAL_TABS = [
            { key: 'manual-all', label: 'All', filter: () => true },
            { key: 'manual-pending', label: 'Pending', filter: t => t.action === 'pending' },
            { key: 'manual-solved', label: 'Solved', filter: t => t.action === 'solved' },
            { key: 'manual-care', label: 'Care', filter: t => t.action === 'care' },
            { key: 'manual-hala', label: 'Hala', filter: t => t.action === 'hala' },
            { key: 'manual-morocco', label: 'Morocco', filter: t => t.action === 'morocco' },
            { key: 'manual-egypt', label: 'Egypt', filter: t => t.action === 'egypt' },
            { key: 'manual-bikeDispute', label: 'Bike', filter: t => t.action === 'bikeDispute' },
            { key: 'manual-careEscalations', label: 'Escalations', filter: t => t.action === 'careEscalations' },
            { key: 'manual-unprocessed', label: 'Unprocessed', filter: t => t.action === 'none' },
        ];

        static async init() {
            try {
                RUMIStorage.getAutomaticSettings();
                RUMIStorage.getManualSettings();
                this.applyTheme(RUMIStorage.getUISettings().theme || 'dark');
                this.attachEventListeners();
                await this.loadViews();

                const settings = RUMIStorage.getProcessingSettings();
                document.getElementById('rumi-dry-run-global').checked = settings.dryRunMode;
                RUMIProcessor.isDryRun = settings.dryRunMode;

                const manualSettings = RUMIStorage.getManualProcessingSettings();
                document.getElementById('rumi-manual-dry-run').checked = manualSettings.dryRunMode;

                this.updateCounters();
                this.renderActiveAutoTab();
                this.updateManualCounters();
                this.renderActiveManualTab();
                this.renderLogs();
                this.renderPinnedList();
                this.initManagementControls();

                RUMILogger.info('UI', 'RUMI v2.1.0 initialized successfully');
            } catch (error) {
                console.error('[RUMI] UI init error:', error);
                RUMILogger.error('UI', 'Failed to initialize', { error: error.message });
            }
        }

        // ── Management controls (single initialization, no double-wiring) ──────
        static initManagementControls() {
            const settings = RUMIStorage.getAutomaticSettings();

            // Routing toggles
            const routings = [
                { key: 'morocco', label: 'Morocco', desc: 'Route to Morocco group', icon: '🇲🇦' },
                { key: 'egypt', label: 'Egypt', desc: 'Route to Egypt group', icon: '🇪🇬' },
                { key: 'rta', label: 'Hala Rides', desc: 'Route to Hala Rides group', icon: '🚗' },
                { key: 'care', label: 'Care Routing', desc: 'Route to Care team', icon: '💙' },
                { key: 'bikeDispute', label: 'Bike Dispute', desc: 'Route Bike Dispute tickets', icon: '🚲' },
            ];
            const routingGrid = document.getElementById('rumi-mgmt-routing-grid');
            if (routingGrid) {
                routingGrid.innerHTML = routings.map(r => {
                    const enabled = r.key === 'morocco'
                        ? settings.actionTypes[r.key] === true
                        : settings.actionTypes[r.key] !== false;
                    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:16px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:8px;">
                        <div>
                            <div style="font-weight:600;">${r.icon} ${r.label}</div>
                            <div style="font-size:12px;color:var(--rumi-text-secondary);">${r.desc}</div>
                        </div>
                        <label class="rumi-toggle-switch">
                            <input type="checkbox" data-routing="${r.key}" ${enabled ? 'checked' : ''}>
                            <span class="rumi-toggle-slider"></span>
                        </label>
                    </div>`;
                }).join('');
                routingGrid.querySelectorAll('input[data-routing]').forEach(cb => {
                    cb.addEventListener('change', () => {
                        const key = cb.dataset.routing;
                        const a = RUMIStorage.getAutomaticSettings();
                        const m = RUMIStorage.getManualSettings();
                        a.actionTypes[key] = cb.checked;
                        m.actionTypes[key] = cb.checked;
                        RUMIStorage.setAutomaticSettings(a);
                        RUMIStorage.setManualSettings(m);
                        
                        const label = `Action Type — ${key.charAt(0).toUpperCase() + key.slice(1)}: ${cb.checked ? 'enabled' : 'disabled'}`;
                        if (RUMIMonitor.isRunning) {
                            RUMIMonitor._hotReload(label);
                        } else {
                            RUMILogger.info('SETTINGS', `[Setting changed] ${label}`);
                        }
                    });
                });
            }

            // Status toggles
            const statuses = [
                { key: 'solved', label: 'Solved Status', desc: 'Auto-set matching tickets to Solved', icon: '✅' },
                { key: 'pending', label: 'Pending Status', desc: 'Auto-set matching tickets to Pending', icon: '⏳' },
                { key: 'customerReplyPending', label: 'Customer Reply — Action Required Check', desc: 'Skip pending if any internal note contains "Action Required" or "Actions Required"', icon: '💬' },
            ];
            const statusGrid = document.getElementById('rumi-mgmt-status-grid');
            if (statusGrid) {
                statusGrid.innerHTML = statuses.map(s => {
                    const enabled = settings.actionTypes[s.key] !== false;
                    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:16px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:8px;">
                        <div>
                            <div style="font-weight:600;">${s.icon} ${s.label}</div>
                            <div style="font-size:12px;color:var(--rumi-text-secondary);">${s.desc}</div>
                        </div>
                        <label class="rumi-toggle-switch">
                            <input type="checkbox" data-status="${s.key}" ${enabled ? 'checked' : ''}>
                            <span class="rumi-toggle-slider"></span>
                        </label>
                    </div>`;
                }).join('');
                statusGrid.querySelectorAll('input[data-status]').forEach(cb => {
                    cb.addEventListener('change', () => {
                        const key = cb.dataset.status;
                        const a = RUMIStorage.getAutomaticSettings();
                        const m = RUMIStorage.getManualSettings();
                        a.actionTypes[key] = cb.checked;
                        m.actionTypes[key] = cb.checked;
                        RUMIStorage.setAutomaticSettings(a);
                        RUMIStorage.setManualSettings(m);
                        
                        const label = `Action Type — ${key.charAt(0).toUpperCase() + key.slice(1)}: ${cb.checked ? 'enabled' : 'disabled'}`;
                        if (RUMIMonitor.isRunning) {
                            RUMIMonitor._hotReload(label);
                        } else {
                            RUMILogger.info('SETTINGS', `[Setting changed] ${label}`);
                        }
                    });
                });
            }

            // PQMS integration toggle
            const pqmsToggle = document.getElementById('toggle-pqms-integration');
            if (pqmsToggle) {
                pqmsToggle.checked = RUMIStorage.get('pqms_integration_enabled', 'on') !== 'off';
                pqmsToggle.addEventListener('change', () => {
                    RUMIStorage.set('pqms_integration_enabled', pqmsToggle.checked ? 'on' : 'off');
                    RUMILogger.info('MGMT', `PQMS integration ${pqmsToggle.checked ? 'enabled' : 'disabled'}`);
                    RUMIUI.showToast(`PQMS integration ${pqmsToggle.checked ? 'enabled' : 'disabled'}`, 'success');
                });
            }

            // PQMS user select
            const pqmsSelect = document.getElementById('rumi-pqms-user-select');
            if (pqmsSelect) {
                const saved = RUMIStorage.getPQMSUser();
                if (saved) pqmsSelect.value = saved.opsId;
                const zId = RUMIProcessor.currentUserId;
                if (zId && ZENDESK_TO_PQMS_USER[String(zId)] && !saved) {
                    const opsId = ZENDESK_TO_PQMS_USER[String(zId)];
                    pqmsSelect.value = opsId;
                    RUMIStorage.setPQMSUser(opsId, PQMS_USERS[opsId]);
                }
                pqmsSelect.addEventListener('change', () => {
                    const opsId = pqmsSelect.value;
                    if (opsId && PQMS_USERS[opsId]) {
                        RUMIStorage.setPQMSUser(opsId, PQMS_USERS[opsId]);
                        RUMILogger.info('MGMT', `PQMS user set: ${PQMS_USERS[opsId]}`);
                        RUMIUI.showToast(`PQMS user: ${PQMS_USERS[opsId]}`, 'success');
                    } else {
                        RUMIStorage.clearPQMSUser();
                    }
                });
            }

            // PQMS submit option
            const pqmsOption = document.getElementById('rumi-mgmt-pqms-option');
            if (pqmsOption) {
                pqmsOption.value = RUMIStorage.getAutomaticSettings().pqmsSubmission || 'solved';
                pqmsOption.addEventListener('change', () => {
                    const a = RUMIStorage.getAutomaticSettings();
                    const m = RUMIStorage.getManualSettings();
                    a.pqmsSubmission = pqmsOption.value;
                    m.pqmsSubmission = pqmsOption.value;
                    RUMIStorage.setAutomaticSettings(a);
                    RUMIStorage.setManualSettings(m);
                    RUMILogger.info('MGMT', `PQMS submission preference: ${pqmsOption.value}`);
                });
            }

            this.updatePQMSCounters();
        }

        static updatePQMSCounters() {
            const total = document.getElementById('rumi-pqms-total-count');
            const solved = document.getElementById('rumi-pqms-solved-count');
            const pending = document.getElementById('rumi-pqms-pending-count');
            if (total) total.textContent = RUMIStorage.getPQMSSubmissionCount();
            if (solved) solved.textContent = RUMIStorage.getPQMSSolvedCount();
            if (pending) pending.textContent = RUMIStorage.getPQMSPendingCount();
        }

        // ── Trigger phrase settings content ────────────────────────────────────
        static _cachedUserInfo = null;

        static renderSettingsContent() {
            const mode = this.currentSettingsMode;
            const settings = mode === 'automatic' ? RUMIStorage.getAutomaticSettings() : RUMIStorage.getManualSettings();
            const container = document.getElementById('rumi-settings-content');
            if (!container) return;

            const categories = [
                { key: 'pending', label: '⏳ Pending Triggers', phrases: RUMIRules.PENDING_TRIGGERS },
                { key: 'solved', label: '✅ Solved Triggers', phrases: RUMIRules.SOLVED_TRIGGERS },
                { key: 'careRouting', label: '💙 Care Routing Phrases', phrases: RUMIRules.CARE_ROUTING_PHRASES },
            ];

            container.innerHTML = categories.map(cat => {
                const stored = settings.triggerPhrases[cat.key] || {};
                const items = cat.phrases.map(p => ({ phrase: p, enabled: stored[p] !== false }));
                const enabledCount = items.filter(i => i.enabled).length;

                return `<div class="rumi-settings-section">
                    <div class="rumi-settings-section-title" style="display:flex;justify-content:space-between;align-items:center;">
                        <span>${cat.label} <span style="font-weight:400;font-size:13px;color:var(--rumi-text-secondary);">(${enabledCount}/${items.length} enabled)</span></span>
                        <div style="display:flex;gap:6px;">
                            <button class="rumi-btn-sm" data-bulk="all" data-cat="${cat.key}" data-mode="${mode}">Toggle All</button>
                            <button class="rumi-btn-sm" data-bulk="invert" data-cat="${cat.key}" data-mode="${mode}">Invert</button>
                        </div>
                    </div>
                    ${items.map(({ phrase, enabled }) => `
                        <div class="rumi-settings-item">
                            <span class="rumi-settings-item-label">${this.escapeHtml(phrase)}</span>
                            <label class="rumi-toggle-switch">
                                <input type="checkbox" data-phrase="${this.escapeHtml(phrase)}" data-cat="${cat.key}" data-mode="${mode}" ${enabled ? 'checked' : ''}>
                                <span class="rumi-toggle-slider"></span>
                            </label>
                        </div>`).join('')}
                </div>`;
            }).join('');

            // Individual toggles
            container.querySelectorAll('input[data-phrase]').forEach(cb => {
                cb.addEventListener('change', () => {
                    const s = cb.dataset.mode === 'automatic' ? RUMIStorage.getAutomaticSettings() : RUMIStorage.getManualSettings();
                    s.triggerPhrases[cb.dataset.cat][cb.dataset.phrase] = cb.checked;
                    cb.dataset.mode === 'automatic' ? RUMIStorage.setAutomaticSettings(s) : RUMIStorage.setManualSettings(s);
                    // Update section count
                    this.renderSettingsContent();
                    
                    const catMap = { pending: 'Pending Triggers', solved: 'Solved Triggers', careRouting: 'Care Routing Phrases' };
                    const label = `${catMap[cb.dataset.cat]}: ${cb.checked ? 'enabled' : 'disabled'}`;
                    if (RUMIMonitor.isRunning) {
                        RUMIMonitor._hotReload(label);
                    } else {
                        RUMILogger.info('SETTINGS', `[Setting changed] ${label}`);
                    }
                });
            });

            // Bulk buttons
            container.querySelectorAll('button[data-bulk]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const s = btn.dataset.mode === 'automatic' ? RUMIStorage.getAutomaticSettings() : RUMIStorage.getManualSettings();
                    const cat = btn.dataset.cat;
                    const phrases = s.triggerPhrases[cat] || {};
                    if (btn.dataset.bulk === 'all') {
                        const allOn = Object.values(phrases).every(v => v);
                        Object.keys(phrases).forEach(k => phrases[k] = !allOn);
                    } else {
                        Object.keys(phrases).forEach(k => phrases[k] = !phrases[k]);
                    }
                    btn.dataset.mode === 'automatic' ? RUMIStorage.setAutomaticSettings(s) : RUMIStorage.setManualSettings(s);
                    this.renderSettingsContent();
                    
                    const catMap = { pending: 'Pending Triggers', solved: 'Solved Triggers', careRouting: 'Care Routing Phrases' };
                    const stateStr = btn.dataset.bulk === 'all' ? 'enabled' : btn.dataset.bulk === 'invert' ? 'inverted' : 'disabled';
                    const label = `${catMap[cat]}: ${stateStr}`;
                    if (RUMIMonitor.isRunning) {
                        RUMIMonitor._hotReload(label);
                    } else {
                        RUMILogger.info('SETTINGS', `[Setting changed] ${label}`);
                    }
                });
            });


        }

        // ── User Info section in Settings tab ──────────────────────────────────
        static async renderUserInfoSection() {
            const container = document.getElementById('rumi-settings-user-info');
            if (!container) return;

            if (this._cachedUserInfo) {
                this._renderUserCard(container, this._cachedUserInfo);
                return;
            }

            container.innerHTML = `<div class="rumi-settings-section" style="color:var(--rumi-text-secondary);font-size:13px;padding:20px;">Loading user info...</div>`;

            try {
                const data = await RUMIAPIManager.get('/api/v2/users/me.json');
                this._cachedUserInfo = data.user;
                this._renderUserCard(container, data.user);
            } catch (e) {
                container.innerHTML = `<div class="rumi-settings-section" style="color:var(--rumi-accent-red);font-size:13px;padding:20px;">Failed to load user info: ${this.escapeHtml(e.message)}</div>`;
                RUMILogger.error('UI', 'Failed to load user info', { error: e.message });
            }
        }

        static _renderUserCard(container, user) {
            const photoUrl = user.photo?.content_url || '';
            const avatarHtml = photoUrl
                ? `<img src="${photoUrl}" style="width:60px;height:60px;border-radius:50%;object-fit:cover;border:2px solid var(--rumi-border);flex-shrink:0;" onerror="this.style.display='none'" />`
                : `<div style="width:60px;height:60px;border-radius:50%;background:var(--rumi-accent-blue);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:white;flex-shrink:0;">${this.escapeHtml((user.name || '?')[0].toUpperCase())}</div>`;
            container.innerHTML = `
                <div class="rumi-settings-section">
                    <div class="rumi-settings-section-title">👤 User Info</div>
                    <div style="display:flex;align-items:center;gap:20px;padding:8px 0;">
                        ${avatarHtml}
                        <div style="display:flex;flex-direction:column;gap:5px;">
                            <div style="font-weight:700;font-size:16px;color:var(--rumi-text);">${this.escapeHtml(user.name || '')}</div>
                            <div style="font-size:13px;color:var(--rumi-text-secondary);">${this.escapeHtml(user.email || '')}</div>
                            <div style="font-size:12px;color:var(--rumi-text-secondary);">Zendesk ID: <code style="background:var(--rumi-bg);padding:2px 8px;border-radius:4px;font-size:12px;">${this.escapeHtml(String(user.id || ''))}</code></div>
                        </div>
                    </div>
                </div>`;
        }

        // ── Event listeners ────────────────────────────────────────────────────
        static attachEventListeners() {
            // Monitor toggle
            const monBtn = document.getElementById('rumi-btn-monitor-toggle');
            monBtn.addEventListener('click', async () => {
                if (RUMIMonitor.isRunning) {
                    RUMIMonitor.stop();
                    monBtn.textContent = 'Start Monitoring';
                    monBtn.className = 'rumi-btn rumi-btn-primary';
                } else {
                    monBtn.disabled = true;
                    monBtn.textContent = 'Starting...';
                    try {
                        const started = await RUMIMonitor.start();
                        monBtn.textContent = started ? 'Stop Monitoring' : 'Start Monitoring';
                        monBtn.className = started ? 'rumi-btn rumi-btn-secondary' : 'rumi-btn rumi-btn-primary';
                    } catch (e) {
                        monBtn.textContent = 'Start Monitoring';
                        monBtn.className = 'rumi-btn rumi-btn-primary';
                        RUMIUI.showToast('Failed to start: ' + e.message, 'error');
                    }
                    monBtn.disabled = false;
                }
            });

            // Theme toggle
            document.getElementById('rumi-btn-theme').onclick = () => {
                const root = document.getElementById('rumi-root');
                const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
                this.applyTheme(next);
                const s = RUMIStorage.getUISettings(); s.theme = next; RUMIStorage.setUISettings(s);
            };

            // View selection
            document.getElementById('rumi-select-all').onclick = () => {
                document.querySelectorAll('.cyber-toggle-checkbox[data-view-id]').forEach(cb => cb.checked = true);
                this.saveSelectedViews();
            };
            document.getElementById('rumi-clear-all').onclick = () => {
                document.querySelectorAll('.cyber-toggle-checkbox[data-view-id]').forEach(cb => cb.checked = false);
                this.saveSelectedViews();
            };

            // Interval — BUG-INTMIN FIX: clamp to CONFIG min/max constants
            document.getElementById('rumi-interval').onchange = e => {
                const val = Math.max(CONFIG.MIN_INTERVAL_SECONDS, Math.min(CONFIG.MAX_INTERVAL_SECONDS, Number(e.target.value)));
                e.target.value = val;
                RUMIMonitor.intervalSeconds = val;
                if (RUMIMonitor.isRunning) {
                    clearInterval(RUMIMonitor.intervalId);
                    RUMIMonitor.intervalId = setInterval(() => {
                        if (RUMIMonitor.isRunning)
                            RUMIMonitor.poll().catch(err =>
                                RUMILogger.error('MONITOR','Poll error',{error:err.message}));
                    }, RUMIMonitor.intervalSeconds * 1000);
                    RUMILogger.info('SETTINGS',
                        `[Live Reload] Monitoring Interval: ${RUMIMonitor.intervalSeconds}s`);
                    RUMIUI.showToast(
                        `Interval updated to ${RUMIMonitor.intervalSeconds}s`, 'info');
                }
            };

            // Dry run global
            document.getElementById('rumi-dry-run-global').onchange = e => {
                if (!e.target.checked && !confirm('Disable dry run? Tickets WILL be modified.')) { e.target.checked = true; return; }
                const s = RUMIStorage.getProcessingSettings(); s.dryRunMode = e.target.checked; RUMIStorage.setProcessingSettings(s);
                RUMIProcessor.isDryRun = e.target.checked;
                
                const label = `Dry Run Mode: ${RUMIProcessor.isDryRun ? 'ON' : 'OFF'}`;
                if (RUMIMonitor.isRunning) {
                    RUMIMonitor._hotReload(label);
                } else {
                    RUMILogger.info('SETTINGS', `[Setting changed] ${label}`);
                }
            };

            // Manual dry run
            document.getElementById('rumi-manual-dry-run').onchange = e => {
                if (!e.target.checked && !confirm('Disable manual dry run? Tickets WILL be modified.')) { e.target.checked = true; return; }
                const s = RUMIStorage.getManualProcessingSettings(); s.dryRunMode = e.target.checked; RUMIStorage.setManualProcessingSettings(s);
                RUMILogger.info('UI', `Manual dry run mode ${e.target.checked ? 'ON' : 'OFF'}`);
                this.showToast(e.target.checked ? 'Manual dry run ON' : 'Manual LIVE mode', e.target.checked ? 'warning' : 'error');
            };

            // Ticket count
            const manualTextarea = document.getElementById('rumi-manual-ids');
            const countEl = document.getElementById('rumi-ticket-count-value');
            const updateCount = () => {
                const count = manualTextarea.value.split(',').map(id => id.trim()).filter(id => /^\d+$/.test(id)).length;
                countEl.textContent = count;
                countEl.style.color = count > 0 ? 'var(--rumi-accent-blue)' : 'var(--rumi-text-secondary)';
            };
            manualTextarea.addEventListener('input', updateCount);
            manualTextarea.addEventListener('paste', () => setTimeout(updateCount, 10));

            // Manual process
            document.getElementById('rumi-manual-process').addEventListener('click', async () => {
                const btn = document.getElementById('rumi-manual-process');
                const progressDiv = document.getElementById('rumi-manual-progress');
                if (btn.textContent.includes('Stop')) { RUMIMonitor.manualProcessingCancelled = true; btn.textContent = 'Stopping...'; btn.disabled = true; return; }
                const ids = manualTextarea.value;
                if (!ids.trim()) { this.showToast('Enter ticket IDs', 'warning'); return; }
                btn.textContent = 'Stop Processing';
                btn.className = 'rumi-btn rumi-btn-secondary';
                progressDiv.style.display = 'block';
                try {
                    const result = await RUMIMonitor.manualProcess(ids, async (current, total) => {
                        progressDiv.textContent = `Processing ${current}/${total}...`;
                        this.updateManualCounters();
                        this.renderActiveManualTab();
                    });
                    this.updateManualCounters();
                    this.renderActiveManualTab();
                    this.showToast(`${result.cancelled ? 'Stopped' : 'Done'}: ${result.processed} processed, ${result.actioned} actioned`, result.cancelled ? 'warning' : 'success');
                    if (!result.cancelled) { manualTextarea.value = ''; countEl.textContent = '0'; }
                } catch (e) {
                    this.showToast('Manual processing failed: ' + e.message, 'error');
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Process Tickets';
                    btn.className = 'rumi-btn rumi-btn-primary';
                    setTimeout(() => { progressDiv.style.display = 'none'; }, 2000);
                }
            });

            // Clear data
            document.getElementById('rumi-reset-counters').onclick = () => {
                if (!confirm('Clear all automatic processing data?')) return;
                RUMIStorage.resetProcessingStats();
                RUMIStorage.clearProcessedTickets();
                RUMIProcessor.clearCachedUserId();
                this.updateCounters();
                this.renderActiveAutoTab();
                RUMILogger.info('UI', 'Automatic data cleared by user');
                this.showToast('Automatic data cleared', 'success');
            };
            document.getElementById('rumi-reset-manual-counters').onclick = () => {
                if (!confirm('Clear all manual processing data?')) return;
                RUMIStorage.resetManualProcessingStats();
                RUMIStorage.clearManualProcessedTickets();
                RUMIProcessor.clearCachedUserId();
                this.updateManualCounters();
                this.renderActiveManualTab();
                RUMILogger.info('UI', 'Manual data cleared by user');
                this.showToast('Manual data cleared', 'success');
            };

            // Export dropdowns
            ['auto', 'manual'].forEach(tab => {
                const btn = document.getElementById(`rumi-export-btn-${tab}`);
                const dropdown = document.getElementById(`rumi-export-dropdown-${tab}`);
                btn.onclick = e => { e.stopPropagation(); dropdown.classList.toggle('active'); };
            });
            document.addEventListener('click', () => document.querySelectorAll('.rumi-export-dropdown').forEach(d => d.classList.remove('active')));
            document.querySelectorAll('.rumi-export-option').forEach(opt => {
                opt.onclick = e => {
                    e.stopPropagation();
                    opt.dataset.exportType === 'csv' ? this.exportAsCSV(opt.dataset.tab) : this.exportAsHTML(opt.dataset.tab);
                    document.querySelectorAll('.rumi-export-dropdown').forEach(d => d.classList.remove('active'));
                };
            });

            // Pin controls
            document.getElementById('rumi-add-pin').onclick = async () => {
                const id = document.getElementById('rumi-pin-ticket-id').value.trim();
                const type = document.querySelector('input[name="rumi-pin-type"]:checked')?.value || 'blocked';
                if (await RUMIPinManager.addPin(id, type)) document.getElementById('rumi-pin-ticket-id').value = '';
            };
            document.getElementById('rumi-pin-ticket-id').onkeypress = e => { if (e.key === 'Enter') document.getElementById('rumi-add-pin').click(); };
            document.getElementById('rumi-pinned-list').onclick = e => {
                if (e.target.classList.contains('rumi-pinned-item-remove')) {
                    RUMIPinManager.removePin(e.target.dataset.ticketId, e.target.dataset.pinType);
                }
            };

            // Main tab switching
            document.querySelectorAll('.rumi-tab-btn[data-main-tab]').forEach(btn => {
                btn.onclick = () => this.switchMainTab(btn.dataset.mainTab);
            });

            // Auto sub-tabs
            document.querySelectorAll('.rumi-tab-btn[data-auto-tab]').forEach(btn => {
                btn.onclick = () => this.switchAutoTab(btn.dataset.autoTab);
            });

            // Manual sub-tabs
            document.querySelectorAll('.rumi-tab-btn[data-manual-tab]').forEach(btn => {
                btn.onclick = () => this.switchManualTab(btn.dataset.manualTab);
            });

            // Settings mode tabs
            document.querySelectorAll('.rumi-settings-sub-tab').forEach(btn => {
                btn.onclick = () => {
                    document.querySelectorAll('.rumi-settings-sub-tab').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    this.currentSettingsMode = btn.dataset.settingsMode;
                    this.renderSettingsContent();
                };
            });

            // Settings bulk buttons
            document.getElementById('rumi-settings-enable-all')?.addEventListener('click', () => this._bulkSettings(true));
            document.getElementById('rumi-settings-disable-all')?.addEventListener('click', () => this._bulkSettings(false));
            document.getElementById('rumi-settings-invert-all')?.addEventListener('click', () => this._bulkSettings('invert'));

            // Settings card navigation (two-level)
            const showSettingsSection = (sectionId) => {
                document.getElementById('rumi-settings-landing').style.display = 'none';
                document.getElementById('rumi-settings-section-triggers').style.display = 'none';
                document.getElementById('rumi-settings-section-account').style.display = 'none';
                document.getElementById(sectionId).style.display = '';
            };
            const showSettingsLanding = () => {
                document.getElementById('rumi-settings-landing').style.display = '';
                document.getElementById('rumi-settings-section-triggers').style.display = 'none';
                document.getElementById('rumi-settings-section-account').style.display = 'none';
            };

            document.getElementById('rumi-settings-card-triggers').addEventListener('click', () => {
                showSettingsSection('rumi-settings-section-triggers');
                this.renderSettingsContent();
            });
            document.getElementById('rumi-settings-card-triggers').addEventListener('mouseenter', function() {
                this.style.borderColor = 'var(--rumi-accent-blue)';
                this.style.boxShadow = '0 4px 16px rgba(37,99,235,0.12)';
            });
            document.getElementById('rumi-settings-card-triggers').addEventListener('mouseleave', function() {
                this.style.borderColor = 'var(--rumi-border)';
                this.style.boxShadow = 'none';
            });

            document.getElementById('rumi-settings-card-account').addEventListener('click', () => {
                showSettingsSection('rumi-settings-section-account');
                RUMIUI.renderUserInfoSection();
            });
            document.getElementById('rumi-settings-card-account').addEventListener('mouseenter', function() {
                this.style.borderColor = 'var(--rumi-accent-blue)';
                this.style.boxShadow = '0 4px 16px rgba(37,99,235,0.12)';
            });
            document.getElementById('rumi-settings-card-account').addEventListener('mouseleave', function() {
                this.style.borderColor = 'var(--rumi-border)';
                this.style.boxShadow = 'none';
            });

            document.getElementById('rumi-settings-back-triggers').addEventListener('click', showSettingsLanding);
            document.getElementById('rumi-settings-back-account').addEventListener('click', showSettingsLanding);

            // Log controls
            document.getElementById('rumi-log-filter').onchange = () => this.renderLogs();
            document.getElementById('rumi-download-logs').onclick = () => this.downloadAllLogs();
            document.getElementById('rumi-clear-logs').onclick = () => {
                if (!confirm('Clear all logs?')) return;
                RUMIStorage.remove('logs');
                this.lastRenderedLogTimestamp = null;
                document.getElementById('rumi-logs-container').innerHTML = '';
                RUMILogger.info('UI', 'Logs cleared by user');
            };
        }

        static _bulkSettings(value) {
            const mode = this.currentSettingsMode;
            const s = mode === 'automatic' ? RUMIStorage.getAutomaticSettings() : RUMIStorage.getManualSettings();
            ['pending', 'solved', 'careRouting'].forEach(cat => {
                Object.keys(s.triggerPhrases[cat] || {}).forEach(phrase => {
                    s.triggerPhrases[cat][phrase] = value === 'invert' ? !s.triggerPhrases[cat][phrase] : value;
                });
            });
            mode === 'automatic' ? RUMIStorage.setAutomaticSettings(s) : RUMIStorage.setManualSettings(s);
            RUMILogger.info('SETTINGS', `Bulk ${value} applied for ${mode} mode`);
            this.renderSettingsContent();
        }

        // ── View loading ───────────────────────────────────────────────────────
        static async loadViews() {
            const container = document.getElementById('rumi-views-list');
            container.innerHTML = '<div style="padding:8px;color:var(--rumi-text-secondary);">Loading views...</div>';
            try {
                const data = await RUMIAPIManager.get('/api/v2/views.json');
                const targetViews = (data.views || []).filter(v => TARGET_VIEWS.includes(v.title));

                if (!targetViews.length) {
                    container.innerHTML = '<div style="color:var(--rumi-accent-red);padding:8px;">No target views found.</div>';
                    return;
                }

                targetViews.forEach(v => {
                    this.viewsMap.set(v.title, v.id);
                    this.viewIdToNameMap.set(String(v.id), v.title);
                });

                const sorted = TARGET_VIEWS.map(t => targetViews.find(v => v.title === t)).filter(Boolean);

                container.innerHTML = sorted.map(v => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:6px;margin-bottom:6px;">
                        <span style="font-size:13px;font-weight:500;">${this.escapeHtml(v.title)}</span>
                        ${cyberToggle(`view-toggle-${v.id}`).replace('<div class="cyber-toggle-wrapper" style="padding:0;">', `<div class="cyber-toggle-wrapper" style="padding:0;"><input type="checkbox" class="cyber-toggle-checkbox" id="view-toggle-${v.id}" data-view-id="${v.id}" />`).replace('<input type="checkbox" class="cyber-toggle-checkbox" id="view-toggle-', `<!-- skip -->`)
                    }
                    </div>`).join('');

                // Rebuild properly (avoid string gymnastics)
                container.innerHTML = sorted.map(v => `
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px;background:var(--rumi-bg);border:1px solid var(--rumi-border);border-radius:6px;margin-bottom:6px;">
                        <span style="font-size:13px;font-weight:500;">${this.escapeHtml(v.title)}</span>
                        <div class="cyber-toggle-wrapper" style="padding:0;">
                            <input type="checkbox" class="cyber-toggle-checkbox" id="view-toggle-${v.id}" data-view-id="${v.id}" />
                            <label for="view-toggle-${v.id}" class="cyber-toggle">
                                <div class="cyber-toggle-track"><div class="cyber-toggle-track-glow"></div><div class="cyber-toggle-track-dots"><span class="cyber-toggle-track-dot"></span><span class="cyber-toggle-track-dot"></span><span class="cyber-toggle-track-dot"></span></div></div>
                                <div class="cyber-toggle-thumb"><div class="cyber-toggle-thumb-shadow"></div><div class="cyber-toggle-thumb-highlight"></div><div class="cyber-toggle-thumb-icon"><svg viewBox="0 0 24 24"><path d="M9 16.2L4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2z"/></svg></div></div>
                                <div class="cyber-toggle-particles"><span class="cyber-toggle-particle"></span><span class="cyber-toggle-particle"></span><span class="cyber-toggle-particle"></span><span class="cyber-toggle-particle"></span></div>
                            </label>
                        </div>
                    </div>`).join('');

                // Restore selections
                const selected = RUMIStorage.getSelectedViews();
                selected.forEach(id => { const cb = container.querySelector(`input[data-view-id="${id}"]`); if (cb) cb.checked = true; });

                container.querySelectorAll('input[data-view-id]').forEach(cb => {
                    cb.addEventListener('change', () => this.saveSelectedViews());
                });

                // View process buttons
                const btnContainer = document.getElementById('rumi-view-buttons-container');
                if (btnContainer) {
                    btnContainer.innerHTML = sorted.map(v => `
                        <button class="rumi-view-process-btn" data-view-id="${v.id}" data-view-name="${this.escapeHtml(v.title)}">
                            ${this.escapeHtml(v.title)}
                        </button>`).join('');
                    btnContainer.querySelectorAll('.rumi-view-process-btn').forEach(btn => {
                        btn.addEventListener('click', async () => {
                            const progressDiv = document.getElementById('rumi-manual-progress');
                            btnContainer.querySelectorAll('.rumi-view-process-btn').forEach(b => b.disabled = true);
                            const origText = btn.textContent;
                            btn.textContent = 'Processing...';
                            progressDiv.style.display = 'block';
                            try {
                                const result = await RUMIMonitor.processView(btn.dataset.viewId, btn.dataset.viewName, progress => {
                                    progressDiv.textContent = progress.phase === 'fetching'
                                        ? `Fetching: ${progress.current} tickets...`
                                        : `Processing ${progress.current}/${progress.total}...`;
                                });
                                this.updateManualCounters();
                                this.renderActiveManualTab();
                                this.showToast(`Done: ${result.fetched} fetched, ${result.actioned} actioned`, 'success');
                            } catch (e) {
                                this.showToast('Failed: ' + e.message, 'error');
                            } finally {
                                btnContainer.querySelectorAll('.rumi-view-process-btn').forEach(b => { b.disabled = false; });
                                btn.textContent = origText;
                                setTimeout(() => { progressDiv.style.display = 'none'; }, 2000);
                            }
                        });
                    });
                }

                RUMILogger.info('UI', `Views loaded: ${sorted.length} views`);
            } catch (error) {
                container.innerHTML = '<div style="color:var(--rumi-accent-red);padding:8px;">Failed to load views.</div>';
                RUMILogger.error('UI', 'Failed to load views', { error: error.message });
            }
        }

        static saveSelectedViews() {
            const selected = Array.from(document.querySelectorAll('.cyber-toggle-checkbox[data-view-id]:checked'))
                .map(cb => String(cb.dataset.viewId));
            RUMIStorage.setSelectedViews(selected);
        }

        // ── Tab switching ──────────────────────────────────────────────────────
        static switchMainTab(tabName) {
            document.querySelectorAll('.rumi-tab-btn[data-main-tab]').forEach(b => b.classList.toggle('active', b.dataset.mainTab === tabName));
            document.querySelectorAll('.rumi-main-tab-panel').forEach(p => p.classList.remove('rumi-tab-visible'));
            const panel = document.getElementById(`rumi-main-${tabName}`);
            if (panel) panel.classList.add('rumi-tab-visible');

            if (tabName === 'logs') this.renderLogs();
            if (tabName === 'settings') {
                // Always return to the landing page when switching to Settings
                document.getElementById('rumi-settings-landing').style.display = '';
                document.getElementById('rumi-settings-section-triggers').style.display = 'none';
                document.getElementById('rumi-settings-section-account').style.display = 'none';
            }
            if (tabName === 'automatic') { this.updateCounters(); this.renderActiveAutoTab(); }
            if (tabName === 'manual') { this.updateManualCounters(); this.renderActiveManualTab(); }
            if (tabName === 'management') this.updatePQMSCounters();
        }

        static switchAutoTab(tabName) {
            this.currentAutoTab = tabName;
            document.querySelectorAll('.rumi-tab-btn[data-auto-tab]').forEach(b => b.classList.toggle('active', b.dataset.autoTab === tabName));
            document.querySelectorAll('#rumi-work-area .rumi-tab-panel').forEach(p => p.classList.remove('active'));
            const panel = document.getElementById(`rumi-tab-${tabName}`);
            if (panel) panel.classList.add('active');
            this.renderActiveAutoTab();
        }

        static switchManualTab(tabName) {
            this.currentManualTab = tabName;
            document.querySelectorAll('.rumi-tab-btn[data-manual-tab]').forEach(b => b.classList.toggle('active', b.dataset.manualTab === tabName));
            document.querySelectorAll('#rumi-work-area-manual .rumi-tab-panel').forEach(p => p.classList.remove('active'));
            // Strip "manual-" prefix to get the panel ID suffix
            const suffix = tabName.replace(/^manual-/, '');
            const panel = document.getElementById(`rumi-manual-tab-${suffix}`);
            if (panel) panel.classList.add('active');
            this.renderActiveManualTab();
        }

        // ── Status / counters ──────────────────────────────────────────────────
        static updateConnectionStatus(status) {
            const dot = document.getElementById('rumi-status-dot');
            const text = document.getElementById('rumi-status-text');
            const monStat = document.getElementById('rumi-monitor-status');
            if (status === 'monitoring') {
                dot.classList.add('rumi-monitoring');
                text.textContent = 'Monitoring';
                monStat.textContent = `Monitoring ${RUMIStorage.getSelectedViews().length} view(s)`;
            } else {
                dot.classList.remove('rumi-monitoring');
                text.textContent = 'Offline';
                monStat.textContent = 'Not monitoring';
            }
        }

        static updateLastRunTime() {
            const el = document.getElementById('rumi-last-run');
            if (el) el.textContent = `Last run: ${new Date().toLocaleString()}`;
        }

        static updateCounters() {
            const stats = RUMIStorage.getProcessingStats();
            const tickets = RUMIStorage.getProcessedTickets();

            const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

            safeSet('rumi-counter-total', stats.totalProcessed);
            safeSet('rumi-counter-pending', stats.pending);
            safeSet('rumi-counter-solved', stats.solved);
            safeSet('rumi-counter-care', stats.care);
            safeSet('rumi-counter-hala', stats.hala);
            safeSet('rumi-counter-morocco', stats.morocco || 0);
            safeSet('rumi-counter-egypt', stats.egypt || 0);
            safeSet('rumi-counter-bikeDispute', stats.bikeDispute || 0);
            safeSet('rumi-counter-careEscalations', stats.careEscalations || 0);

            // Update tab labels
            this.AUTO_TABS.forEach(tab => {
                const btn = document.querySelector(`[data-auto-tab="${tab.key}"]`);
                if (btn) btn.textContent = `${tab.label} (${tickets.filter(tab.filter).length})`;
            });
        }

        static updateManualCounters() {
            const stats = RUMIStorage.getManualProcessingStats();
            const tickets = RUMIStorage.getManualProcessedTickets();

            const safeSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

            safeSet('rumi-manual-counter-total', stats.totalProcessed);
            safeSet('rumi-manual-counter-pending', stats.pending);
            safeSet('rumi-manual-counter-solved', stats.solved);
            safeSet('rumi-manual-counter-care', stats.care);
            safeSet('rumi-manual-counter-hala', stats.hala);
            safeSet('rumi-manual-counter-morocco', stats.morocco || 0);
            safeSet('rumi-manual-counter-egypt', stats.egypt || 0);
            safeSet('rumi-manual-counter-bikeDispute', stats.bikeDispute || 0);
            safeSet('rumi-manual-counter-careEscalations', stats.careEscalations || 0);

            this.MANUAL_TABS.forEach(tab => {
                const btn = document.querySelector(`[data-manual-tab="${tab.key}"]`);
                if (btn) btn.textContent = `${tab.label} (${tickets.filter(tab.filter).length})`;
            });
        }

        // ── Table rendering ────────────────────────────────────────────────────
        static renderActiveAutoTab() {
            const tickets = RUMIStorage.getProcessedTickets();
            const tab = this.AUTO_TABS.find(t => t.key === this.currentAutoTab) || this.AUTO_TABS[0];
            this.currentAutoTab = tab.key;

            // `rumi-tab-panel` is `display:none` unless it has `active`.
            document.querySelectorAll('#rumi-work-area .rumi-tab-panel')
                .forEach(p => p.classList.remove('active'));
            document.getElementById(`rumi-tab-${this.currentAutoTab}`)?.classList.add('active');

            this.renderTicketsTable(`rumi-table-${this.currentAutoTab}`, tickets.filter(tab.filter));
        }

        static renderActiveManualTab() {
            const tickets = RUMIStorage.getManualProcessedTickets();
            const tab = this.MANUAL_TABS.find(t => t.key === this.currentManualTab) || this.MANUAL_TABS[0];
            this.currentManualTab = tab.key;

            // tbody id derivation: strip "manual-" prefix
            const suffix = this.currentManualTab.replace(/^manual-/, '');
            const panelId = `rumi-manual-tab-${suffix}`;
            const tbodyId = `rumi-manual-table-${suffix}`;

            // Ensure manual tables are visible on initial render.
            document.querySelectorAll('#rumi-work-area-manual .rumi-tab-panel')
                .forEach(p => p.classList.remove('active'));
            document.getElementById(panelId)?.classList.add('active');

            this.renderTicketsTable(tbodyId, tickets.filter(tab.filter));
        }

        static renderTicketsTable(tbodyId, tickets) {
            const tbody = document.getElementById(tbodyId);
            if (!tbody) return;
            if (!tickets.length) {
                tbody.innerHTML = '<tr><td colspan="14" style="text-align:center;padding:40px;color:var(--rumi-text-secondary);">No tickets yet</td></tr>';
                return;
            }
            const reversed = [...tickets].reverse();
            tbody.innerHTML = reversed.map((ticket, i) => {
                const rowNum = reversed.length - i;
                const action = (ticket.action || '').toLowerCase();
                const isDryRun = ticket.dryRun;
                const isAlreadyCorrect = ticket.alreadyCorrect;

                const actionBadge = `<span class="rumi-badge rumi-badge-${action}">${action || 'none'}</span>`;
                const prevBadge = `<span class="rumi-status-badge rumi-status-badge-${ticket.previousStatus}">${ticket.previousStatus || 'N/A'}</span>`;
                const newBadge = `<span class="rumi-status-badge rumi-status-badge-${ticket.newStatus}">${ticket.newStatus || 'N/A'}</span>`;
                const dryBadge = isDryRun ? '<span class="rumi-badge rumi-badge-yes">YES</span>' : '<span class="rumi-badge rumi-badge-no">NO</span>';
                const updBadge = (isDryRun || isAlreadyCorrect)
                    ? '<span class="rumi-badge rumi-badge-no">NO</span>'
                    : '<span class="rumi-badge rumi-badge-yes">YES</span>';
                const isPQMS = RUMIStorage.isTicketSubmittedToPQMS(ticket.ticketId);
                const showPQMSBtn = !isPQMS && (action === 'solved' || action === 'pending');

                const pqmsCell = isPQMS
                    ? '<span style="color:#22c55e;font-size:16px;" title="Submitted to PQMS">✓</span>'
                    : showPQMSBtn
                        ? `<button class="rumi-pqms-submit-btn" data-ticket-id="${ticket.ticketId}" data-subject="${this.escapeHtml(ticket.subject || '')}" data-group="${this.escapeHtml(ticket.previousGroupName || '')}" data-action="${action}" style="padding:2px 8px;font-size:11px;background:#22c55e;color:white;border:none;border-radius:4px;cursor:pointer;">SUBMIT</button>`
                        : '<span style="color:var(--rumi-text-secondary);font-size:11px;">—</span>';

                return `<tr class="${isDryRun ? 'rumi-dry-run' : ''}">
                    <td>${pqmsCell}</td>
                    <td>${rowNum}</td>
                    <td><a href="/agent/tickets/${ticket.ticketId}" target="_blank">${ticket.ticketId}</a></td>
                    <td style="max-width:260px;white-space:normal;word-wrap:break-word;">${this.escapeHtml(ticket.subject || 'N/A')}</td>
                    <td>${this.escapeHtml(ticket.viewName || 'N/A')}</td>
                    <td>${actionBadge}</td>
                    <td style="max-width:220px;white-space:normal;word-wrap:break-word;">${this.escapeHtml(ticket.trigger || 'N/A')}</td>
                    <td>${prevBadge}</td>
                    <td>${newBadge}</td>
                    <td>${this.escapeHtml(ticket.previousGroupName || 'N/A')}</td>
                    <td>${this.escapeHtml(ticket.newGroupName || 'N/A')}</td>
                    <td>${new Date(ticket.timestamp).toLocaleString()}</td>
                    <td>${dryBadge}</td>
                    <td>${updBadge}</td>
                </tr>`;
            }).join('');

            // PQMS manual submit
            tbody.querySelectorAll('.rumi-pqms-submit-btn').forEach(btn => {
                btn.onclick = async e => {
                    const el = e.target;
                    el.disabled = true; el.textContent = '...';
                    const fn = el.dataset.action === 'pending' ? RUMIPQMS.submitPendingTicket : RUMIPQMS.submitSolvedTicket;
                    const ok = await fn.call(RUMIPQMS, el.dataset.ticketId, el.dataset.subject, el.dataset.group, false, true);
                    if (ok) {
                        el.closest('td').innerHTML = '<span style="color:#22c55e;font-size:16px;">✓</span>';
                        RUMIUI.showToast(`Ticket ${el.dataset.ticketId} submitted to PQMS`, 'success');
                        RUMIUI.updatePQMSCounters();
                    } else {
                        el.disabled = false; el.textContent = 'SUBMIT';
                        RUMIUI.showToast('PQMS submission failed', 'error');
                    }
                };
            });
        }

        // ── Logs rendering ─────────────────────────────────────────────────────
        static renderLogs() {
            if (this.logRenderScheduled) return;
            this.logRenderScheduled = true;
            requestAnimationFrame(() => {
                this.logRenderScheduled = false;
                const filter = document.getElementById('rumi-log-filter')?.value || 'all';
                const container = document.getElementById('rumi-logs-container');
                if (!container) return;

                if (filter !== this.currentLogFilter) {
                    this.currentLogFilter = filter;
                    this.lastRenderedLogTimestamp = null;
                    container.innerHTML = '';
                }

                const logs = RUMIStorage.getLogs();
                const filtered = filter === 'all' ? logs : logs.filter(l => l.level === filter);
                const toRender = filtered.slice(-200);

                if (!toRender.length) { container.innerHTML = '<div style="padding:20px;text-align:center;color:var(--rumi-text-secondary);">No logs</div>'; return; }

                const newLogs = this.lastRenderedLogTimestamp === null
                    ? toRender
                    : toRender.filter(l => l.timestamp > this.lastRenderedLogTimestamp);

                if (!newLogs.length) return;

                const frag = document.createDocumentFragment();
                for (let i = newLogs.length - 1; i >= 0; i--) {
                    const l = newLogs[i];
                    const div = document.createElement('div');
                    div.className = `rumi-log-entry rumi-${l.level}`;
                    const ts = new Date(new Date(l.timestamp).getTime() + 3 * 3600000).toISOString().replace('T', ' ').substring(0, 19);
                    div.innerHTML = `<strong>${ts}</strong> [${l.level.toUpperCase()}] <strong>${l.module}</strong>: ${this.escapeHtml(l.message)}${Object.keys(l.meta || {}).length ? `<div class="rumi-log-meta">${this.escapeHtml(JSON.stringify(l.meta))}</div>` : ''}`;
                    frag.appendChild(div);
                }
                container.insertBefore(frag, container.firstChild);
                this.lastRenderedLogTimestamp = toRender[toRender.length - 1].timestamp;

                const entries = container.querySelectorAll('.rumi-log-entry');
                if (entries.length > 200) for (let i = 200; i < entries.length; i++) entries[i].remove();
            });
        }

        // ── Pinned list ────────────────────────────────────────────────────────
        static renderPinnedList() {
            const container = document.getElementById('rumi-pinned-list');
            if (!container) return;
            const blocked = RUMIStorage.getPinnedBlocked().map(p => ({ ...p, type: 'blocked' }));
            const care = RUMIStorage.getPinnedCareRouting().map(p => ({ ...p, type: 'care_routing' }));
            const all = [...blocked, ...care].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

            if (!all.length) { container.innerHTML = '<div class="rumi-pinned-empty">No pinned tickets</div>'; return; }

            container.innerHTML = all.map(pin => {
                const url = `https://gocareem.zendesk.com/agent/tickets/${pin.ticketId}`;
                const ts = new Date(pin.timestamp).toLocaleString();
                let badgeOptions = '';
                if (pin.type === 'blocked') {
                    if (pin.reason === 'double_route') {
                        badgeOptions = '<span class="rumi-pinned-item-badge rumi-pinned-badge-blocked">BLOCKED</span><span style="font-size:10px;color:var(--rumi-text-secondary);margin-left:4px;opacity:0.7;">(auto-blocked)</span>';
                    } else {
                        badgeOptions = '<span class="rumi-pinned-item-badge rumi-pinned-badge-blocked">BLOCKED</span>';
                    }
                } else {
                    badgeOptions = pin.status === 'active'
                        ? '<span class="rumi-pinned-item-badge rumi-pinned-badge-care-active">CARE ROUTING — ACTIVE</span>'
                        : '<span class="rumi-pinned-item-badge rumi-pinned-badge-care-changed">CARE ROUTING — CHANGED</span>';
                }
                return `<div class="rumi-pinned-item">
                    <div class="rumi-pinned-item-header">
                        <div>${badgeOptions}</div>
                        <button class="rumi-pinned-item-remove" data-ticket-id="${pin.ticketId}" data-pin-type="${pin.type}">Remove</button>
                    </div>
                    <div class="rumi-pinned-item-info">
                        <div>Ticket: <a href="${url}" target="_blank" class="rumi-pinned-item-link">${pin.ticketId}</a></div>
                        <div style="font-size:11px;">Pinned: ${ts}</div>
                    </div>
                </div>`;
            }).join('');
        }

        // ── Helpers ────────────────────────────────────────────────────────────
        static applyTheme(theme) {
            const root = document.getElementById('rumi-root');
            if (root) root.setAttribute('data-theme', theme);
        }

        static showToast(message, type = 'info') {
            const colors = { success: '#10B981', error: '#EF4444', warning: '#F59E0B', info: '#2563EB' };
            const toast = document.createElement('div');
            toast.style.cssText = `position:fixed;bottom:20px;right:20px;padding:12px 20px;background:${colors[type] || colors.info};color:white;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:1000000;font-size:14px;font-weight:500;max-width:400px;animation:rumi-toast-in 0.3s ease-out;`;
            toast.textContent = message;
            document.body.appendChild(toast);
            setTimeout(() => { toast.style.animation = 'rumi-toast-out 0.3s ease-out'; setTimeout(() => toast.remove(), 300); }, 4000);
        }

        static escapeHtml(text) {
            const div = document.createElement('div'); div.textContent = String(text || ''); return div.innerHTML;
        }

        static async getViewName(viewId) {
            const cached = this.viewIdToNameMap.get(String(viewId));
            if (cached) return cached;
            try {
                const data = await RUMIAPIManager.get(`/api/v2/views/${viewId}.json`);
                const name = data.view?.title || `View ${viewId}`;
                this.viewIdToNameMap.set(String(viewId), name);
                return name;
            } catch { return `View ${viewId}`; }
        }

        // ── Export ─────────────────────────────────────────────────────────────
        static exportAsCSV(tab) {
            const tickets = tab === 'auto' ? RUMIStorage.getProcessedTickets() : RUMIStorage.getManualProcessedTickets();
            if (!tickets.length) { this.showToast('No tickets to export', 'warning'); return; }
            const BOM = '\uFEFF';
            const headers = ['Ticket ID', 'Subject', 'View', 'Action', 'Trigger', 'Prev Status', 'New Status', 'Prev Group', 'New Group', 'Processed At', 'Dry Run', 'Updated?'];
            const rows = tickets.map(t => [
                t.ticketId, `"${(t.subject || '').replace(/"/g, '""')}"`, `"${(t.viewName || '').replace(/"/g, '""')}"`,
                t.action, `"${(t.trigger || '').replace(/"/g, '""')}"`, t.previousStatus || '', t.newStatus || '',
                `"${(t.previousGroupName || '').replace(/"/g, '""')}"`, `"${(t.newGroupName || '').replace(/"/g, '""')}"`,
                `"${new Date(t.timestamp).toLocaleString()}"`, t.dryRun ? 'YES' : 'NO', t.alreadyCorrect ? 'NO' : 'YES'
            ].join(','));
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([BOM + headers.join(',') + '\n' + rows.join('\n')], { type: 'text/csv;charset=utf-8;' }));
            a.download = `rumi-${tab}-${new Date().toISOString().split('T')[0]}.csv`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            RUMILogger.info('UI', `CSV exported: ${tickets.length} tickets (${tab})`);
            this.showToast(`Exported ${tickets.length} tickets as CSV`, 'success');
        }

        static exportAsHTML(tab) {
            const tickets = tab === 'auto' ? RUMIStorage.getProcessedTickets() : RUMIStorage.getManualProcessedTickets();
            if (!tickets.length) { this.showToast('No tickets to export', 'warning'); return; }
            const rows = tickets.map((t, i) => `<tr>
                <td>${i + 1}</td><td><a href="/agent/tickets/${t.ticketId}" target="_blank">${t.ticketId}</a></td>
                <td>${this.escapeHtml(t.subject || '')}</td><td>${t.action}</td>
                <td>${this.escapeHtml(t.trigger || '')}</td><td>${t.previousStatus || ''}</td>
                <td>${t.newStatus || ''}</td><td>${this.escapeHtml(t.previousGroupName || '')}</td>
                <td>${this.escapeHtml(t.newGroupName || '')}</td>
                <td>${new Date(t.timestamp).toLocaleString()}</td>
                <td>${t.dryRun ? 'YES' : 'NO'}</td><td>${t.alreadyCorrect ? 'NO' : 'YES'}</td>
            </tr>`).join('');
            const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>RUMI Export</title>
                <style>body{font-family:sans-serif;padding:20px;}table{border-collapse:collapse;width:100%;}th,td{border:1px solid #ccc;padding:8px;font-size:12px;}th{background:#f5f5f5;}</style>
                </head><body><h2>RUMI ${tab} Export — ${new Date().toLocaleString()}</h2>
                <table><thead><tr><th>#</th><th>Ticket</th><th>Subject</th><th>Action</th><th>Trigger</th><th>Prev Status</th><th>New Status</th><th>Prev Group</th><th>New Group</th><th>Time</th><th>Dry Run</th><th>Updated?</th></tr></thead>
                <tbody>${rows}</tbody></table></body></html>`;
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8;' }));
            a.download = `rumi-${tab}-${new Date().toISOString().split('T')[0]}.html`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            RUMILogger.info('UI', `HTML exported: ${tickets.length} tickets (${tab})`);
            this.showToast(`Exported ${tickets.length} tickets as HTML`, 'success');
        }

        static downloadAllLogs() {
            const logs = RUMIStorage.getLogs();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' }));
            a.download = `rumi-logs-${new Date().toISOString().replace(/:/g, '-')}.json`;
            document.body.appendChild(a); a.click(); document.body.removeChild(a);
            this.showToast(`Downloaded ${logs.length} log entries`, 'success');
        }
    }

    // ============================================================================
    // INITIALIZATION
    // ============================================================================

    const ZENDESK_HIDE_SELECTORS = ['#root', 'body > .app', 'body > main', '[data-garden-id="chrome"]'];

    function hideZendeskUI() {
        ZENDESK_HIDE_SELECTORS.forEach(sel => {
            document.querySelectorAll(sel).forEach(el => {
                if (el.id !== 'rumi-root') {
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                }
            });
        });
        const rumiRoot = document.getElementById('rumi-root');
        if (rumiRoot) {
            rumiRoot.style.setProperty('z-index', '2147483647', 'important');
            rumiRoot.style.setProperty('display', 'flex', 'important');
            rumiRoot.style.setProperty('visibility', 'visible', 'important');
        }
    }

    // BUG-14 FIX: store observer reference; gate callback so it only fires when rumi-root display
    // actually changes (avoiding dozens of re-paints per second); disconnect on page unload.
    let _zenDeskHideObserver = null;
    let _rumiRootDisplayState = null;

    function startZendeskHideObserver() {
        if (_zenDeskHideObserver) _zenDeskHideObserver.disconnect();

        let _hideDebounce = null;
        _zenDeskHideObserver = new MutationObserver(() => {
            if (_hideDebounce) clearTimeout(_hideDebounce);
            _hideDebounce = setTimeout(hideZendeskUI, 50);
        });
        _zenDeskHideObserver.observe(document.body, { childList: true, subtree: true });

        window.addEventListener('beforeunload', () => {
            if (_zenDeskHideObserver) { _zenDeskHideObserver.disconnect(); _zenDeskHideObserver = null; }
        }, { once: true });

        return _zenDeskHideObserver;
    }

    function injectStyles() {
        const styleEl = document.createElement('style');
        styleEl.textContent = CSS_STYLES;
        document.head.appendChild(styleEl);
    }

    function injectHTML() {
        const container = document.createElement('div');
        container.innerHTML = HTML_TEMPLATE;
        document.body.appendChild(container.firstElementChild);
    }

    async function initRUMI() {
        try {
            RUMILogger.info('INIT', 'RUMI v2.1.0 initialization starting');
            hideZendeskUI();
            injectStyles();
            injectHTML();
            startZendeskHideObserver();
            await RUMIAPIManager.init();
            await RUMIProcessor.init();
            await RUMIUI.init();
            window.RUMIUI = RUMIUI;
            RUMILogger.info('INIT', 'RUMI v2.1.0 ready ✓');
        } catch (error) {
            console.error('[RUMI] Initialization failed:', error);
            RUMILogger.error('INIT', 'Failed to initialize', { error: error.message });
        }
    }

    if (document.body) initRUMI();
    else document.addEventListener('DOMContentLoaded', initRUMI);

})();
