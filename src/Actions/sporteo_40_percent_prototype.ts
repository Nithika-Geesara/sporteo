/**
 * ============================================================================
 * SPORTEO (Team DevGrid) — 40% Working Prototype Implementation (Next.js + Prisma)
 * Course: IS 2901 – Software Development Project (University of Moratuwa, 2026)
 * Client: Enlear (Pvt) LTD | Interim Evaluation Deadline: October 21, 2026
 * ============================================================================
 *
 * This module implements the core 40% Prototype Server Actions & Domain Services
 * for all 5 Team DevGrid members with strict module boundaries:
 *
 *  - Module 1 (N G Rangodage - 245082F): Auth/RBAC (403 Guard), S3 NIC Verification & Club Roster
 *  - Module 2 (JBAN Lakvindu - 245128E): Age-Categorized Courses, Capacity Lock & Conflict-Free Reschedule
 *  - Module 3 (KPVM Pathirana - 245073E): Concurrent Court Booking Lock & Inter-Club Match Coordination
 *  - Module 4 (WMSD Weerasingha - 245115R): Explainable Coach Search, RAG Assistant & Notifications
 *  - Module 5 (AMT Mandinu - 245062U): Sandbox Checkout, 10% Commission Split, Idempotent Webhooks & Refunds
 */
"use server";

import { PrismaClient, Prisma, UserRole, SportType, SkillLevel, AgeBracket } from "@prisma/client";

export const prisma = new PrismaClient();

// Shared HTTP-style Domain Error for Next.js Server Actions & Route Handlers
export class SporteoHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SporteoHttpError";
  }
}

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
}

// ============================================================================
// MODULE 4 (SHARED EVENT BUS CONTRACT): WMSD Weerasingha (245115R)
// Cross-Module Notification Dispatcher (Consumed by M1, M2, M3, M5)
// ============================================================================

export async function dispatchPlatformNotification(
  tx: Prisma.TransactionClient | PrismaClient,
  params: {
    recipientUserId: string;
    eventType: string;
    title: string;
    body: string;
    actionUrl?: string;
  }
) {
  return tx.notification.create({
    data: {
      recipientUserId: params.recipientUserId,
      eventType: params.eventType,
      title: params.title,
      body: params.body,
      actionUrl: params.actionUrl ?? null,
      isRead: false,
    },
  });
}

// ============================================================================
// MODULE 1: N G Rangodage (245082F)
// User Access, NIC Verification & Club Management
// ============================================================================
// 40% Demo Requirement:
// 1. Player registers, submits NIC info, applies to a club, gets approved by
//    the Club Manager, and appears on the official club roster.
// 2. Unauthorized users are blocked (403) from restricted admin/verification records.

const SRI_LANKA_NIC_REGEX = /^([0-9]{9}[vVxX]|[0-9]{12})$/;

/**
 * FR-M1-01: Strict Role-Based Access Control (RBAC) Guard
 * Throws HTTP 403 Forbidden when an unauthorized role accesses restricted records.
 */
export function requireRole(sessionUser: SessionUser | null, allowedRoles: UserRole[]): SessionUser {
  if (!sessionUser) {
    throw new SporteoHttpError(401, "UNAUTHORIZED", "Authentication required.");
  }
  if (!allowedRoles.includes(sessionUser.role)) {
    throw new SporteoHttpError(
      403,
      "FORBIDDEN_ROLE",
      `Access Denied (403): Role '${sessionUser.role}' cannot access resources restricted to [${allowedRoles.join(", ")}].`
    );
  }
  return sessionUser;
}

/**
 * FR-M1-02: Player Registration & Mandatory NIC Submission (Amazon S3 Keys)
 */
export async function submitPlayerNicVerification(
  sessionUser: SessionUser,
  payload: {
    dateOfBirth: string; // YYYY-MM-DD
    nicNumber: string;
    primarySport: SportType;
    skillLevel: SkillLevel;
    s3FrontKey: string;
    s3BackKey: string;
  }
) {
  requireRole(sessionUser, [UserRole.PLAYER]);

  if (!SRI_LANKA_NIC_REGEX.test(payload.nicNumber.trim())) {
    throw new SporteoHttpError(
      422,
      "INVALID_NIC_FORMAT",
      "Invalid Sri Lankan NIC format. Expected 9 digits + V/X or 12 digits."
    );
  }

  return prisma.$transaction(async (tx) => {
    const profile = await tx.playerProfile.upsert({
      where: { userId: sessionUser.id },
      update: {
        dateOfBirth: new Date(payload.dateOfBirth),
        nicNumber: payload.nicNumber.trim().toUpperCase(),
        primarySport: payload.primarySport,
        skillLevel: payload.skillLevel,
      },
      create: {
        userId: sessionUser.id,
        dateOfBirth: new Date(payload.dateOfBirth),
        nicNumber: payload.nicNumber.trim().toUpperCase(),
        primarySport: payload.primarySport,
        skillLevel: payload.skillLevel,
        isNicVerified: false,
      },
    });

    const submission = await tx.nicVerification.create({
      data: {
        playerProfileId: profile.id,
        s3FrontKey: payload.s3FrontKey,
        s3BackKey: payload.s3BackKey,
        status: "PENDING",
      },
    });

    return { profile, submission };
  });
}

/**
 * FR-M1-03: System Admin NIC Verification Review Queue (Protected by 403 RBAC Guard)
 */
export async function reviewNicVerificationByAdmin(
  sessionUser: SessionUser,
  payload: {
    verificationId: string;
    decision: "APPROVED" | "REJECTED";
    reviewNotes?: string;
  }
) {
  // Blocks PLAYER, COACH, CLUB_MANAGER, VENUE_OWNER with 403 Forbidden
  const admin = requireRole(sessionUser, [UserRole.SYSTEM_ADMIN]);

  return prisma.$transaction(async (tx) => {
    const verification = await tx.nicVerification.update({
      where: { id: payload.verificationId },
      data: {
        status: payload.decision,
        reviewedByAdminId: admin.id,
        reviewNotes: payload.reviewNotes ?? null,
        reviewedAt: new Date(),
      },
      include: { playerProfile: true },
    });

    if (payload.decision === "APPROVED") {
      await tx.playerProfile.update({
        where: { id: verification.playerProfileId },
        data: { isNicVerified: true },
      });
    }

    await dispatchPlatformNotification(tx, {
      recipientUserId: verification.playerProfile.userId,
      eventType: "NIC_VERIFICATION_DECISION",
      title: `NIC Verification ${payload.decision}`,
      body:
        payload.decision === "APPROVED"
          ? "Your NIC document has been verified. You can now apply to join Sports Clubs."
          : `Your NIC verification was rejected: ${payload.reviewNotes ?? "Please re-upload clear documents."}`,
      actionUrl: "/player/profile",
    });

    return verification;
  });
}

/**
 * FR-M1-05 (Part A): Verified Player Applies to Join a Sports Club
 */
export async function applyForClubMembership(
  sessionUser: SessionUser,
  payload: {
    clubId: string;
    preferredSport: SportType;
    playingPosition: string;
    experienceSummary?: string;
  }
) {
  requireRole(sessionUser, [UserRole.PLAYER]);

  const playerProfile = await prisma.playerProfile.findUnique({
    where: { userId: sessionUser.id },
  });

  if (!playerProfile || !playerProfile.isNicVerified) {
    throw new SporteoHttpError(
      403,
      "NIC_VERIFICATION_REQUIRED",
      "Mandatory NIC verification must be approved by System Admin before applying to a Sports Club."
    );
  }

  return prisma.clubMembershipApplication.create({
    data: {
      clubId: payload.clubId,
      playerProfileId: playerProfile.id,
      preferredSport: payload.preferredSport,
      playingPosition: payload.playingPosition,
      experienceSummary: payload.experienceSummary ?? null,
      status: "PENDING",
    },
  });
}

/**
 * FR-M1-05 (Part B): Club Manager Approves Application -> Player Appears on Official Club Roster
 */
export async function approveClubMembershipApplication(
  sessionUser: SessionUser,
  payload: {
    applicationId: string;
    squadRole: string;
    jerseyNumber?: number;
  }
) {
  const manager = requireRole(sessionUser, [UserRole.CLUB_MANAGER]);

  return prisma.$transaction(async (tx) => {
    const application = await tx.clubMembershipApplication.findUnique({
      where: { id: payload.applicationId },
      include: { club: true, playerProfile: true },
    });

    if (!application) {
      throw new SporteoHttpError(404, "APPLICATION_NOT_FOUND", "Membership application not found.");
    }

    if (application.club.managerUserId !== manager.id) {
      throw new SporteoHttpError(
        403,
        "NOT_CLUB_OWNER",
        "Access Denied (403): You can only approve applications for clubs you manage."
      );
    }

    const updatedApplication = await tx.clubMembershipApplication.update({
      where: { id: application.id },
      data: {
        status: "APPROVED",
        reviewedByManagerId: manager.id,
        decidedAt: new Date(),
      },
    });

    const rosterMember = await tx.clubRosterMember.create({
      data: {
        clubId: application.clubId,
        playerProfileId: application.playerProfileId,
        sportName: application.preferredSport,
        squadRole: payload.squadRole,
        jerseyNumber: payload.jerseyNumber ?? null,
        isActiveMember: true,
      },
    });

    await dispatchPlatformNotification(tx, {
      recipientUserId: application.playerProfile.userId,
      eventType: "CLUB_MEMBERSHIP_APPROVED",
      title: `Welcome to ${application.club.clubName}!`,
      body: `Your membership application was approved. You are now listed on the official ${application.preferredSport} roster as ${payload.squadRole}.`,
      actionUrl: `/clubs/${application.clubId}/roster`,
    });

    return { updatedApplication, rosterMember };
  });
}

// ============================================================================
// MODULE 2: JBAN Lakvindu (245128E)
// Coaching Services, Courses & Session Scheduling
// ============================================================================
// 40% Demo Requirement:
// 1. A coach creates an age-categorized course (8-12, 13-19, 20+).
// 2. Eligible players enroll until max capacity is reached (blocking further enrollments).
// 3. A session is rescheduled without creating a coach schedule conflict.

function calculateAgeInYears(dob: Date, referenceDate: Date = new Date()): number {
  let age = referenceDate.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = referenceDate.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

function isAgeEligibleForBracket(age: number, bracket: AgeBracket): boolean {
  switch (bracket) {
    case AgeBracket.AGE_8_12:
      return age >= 8 && age <= 12;
    case AgeBracket.AGE_13_19:
      return age >= 13 && age <= 19;
    case AgeBracket.AGE_20_PLUS:
      return age >= 20;
    default:
      return false;
  }
}

/**
 * FR-M2-02: Coach Creates an Age-Categorized Group Course with Capacity Limit
 */
export async function createCoachingCourse(
  sessionUser: SessionUser,
  payload: {
    title: string;
    sportName: SportType;
    ageBracket: AgeBracket;
    skillLevel: SkillLevel;
    courseFeeLkr: number;
    maxCapacity: number;
    startDate: string;
    endDate: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }
) {
  requireRole(sessionUser, [UserRole.COACH]);

  if (payload.maxCapacity < 1) {
    throw new SporteoHttpError(422, "INVALID_CAPACITY", "Course maxCapacity must be at least 1.");
  }

  const coachProfile = await prisma.coachProfile.findUnique({
    where: { userId: sessionUser.id },
  });
  if (!coachProfile) {
    throw new SporteoHttpError(404, "COACH_PROFILE_NOT_FOUND", "Coach profile not found.");
  }

  return prisma.coachingCourse.create({
    data: {
      coachProfileId: coachProfile.id,
      title: payload.title,
      sportName: payload.sportName,
      ageBracket: payload.ageBracket,
      skillLevel: payload.skillLevel,
      courseFeeLkr: new Prisma.Decimal(payload.courseFeeLkr),
      maxCapacity: payload.maxCapacity,
      currentEnrollment: 0,
      startDate: new Date(payload.startDate),
      endDate: new Date(payload.endDate),
      dayOfWeek: payload.dayOfWeek,
      startTime: payload.startTime,
      endTime: payload.endTime,
      status: "OPEN",
    },
  });
}

/**
 * FR-M2-03: Player Enrolls in Course with Age Eligibility & Atomic Capacity Lock
 */
export async function enrollInCoachingCourse(
  sessionUser: SessionUser,
  courseId: string
) {
  requireRole(sessionUser, [UserRole.PLAYER]);

  return prisma.$transaction(
    async (tx) => {
      const player = await tx.playerProfile.findUnique({
        where: { userId: sessionUser.id },
      });
      if (!player) {
        throw new SporteoHttpError(404, "PLAYER_NOT_FOUND", "Player profile not found.");
      }

      // Acquire row-level lock on the course record to prevent concurrent over-enrollment
      const lockedCourses = await tx.$queryRaw<
        Array<{
          id: string;
          title: string;
          age_bracket: AgeBracket;
          max_capacity: number;
          current_enrollment: number;
          status: string;
        }>
      >`
        SELECT id, title, age_bracket, max_capacity, current_enrollment, status
        FROM coaching_courses
        WHERE id = ${courseId}::uuid
        FOR UPDATE
      `;

      const course = lockedCourses[0];
      if (!course) {
        throw new SporteoHttpError(404, "COURSE_NOT_FOUND", "Coaching course not found.");
      }

      // 1. Validate Age Eligibility (8-12, 13-19, 20+)
      const playerAge = calculateAgeInYears(player.dateOfBirth);
      if (!isAgeEligibleForBracket(playerAge, course.age_bracket)) {
        throw new SporteoHttpError(
          422,
          "AGE_ELIGIBILITY_MISMATCH",
          `Player age (${playerAge}) does not match course bracket '${course.age_bracket}'.`
        );
      }

      // 2. Enforce Strict Capacity Limit
      if (course.current_enrollment >= course.max_capacity || course.status === "FULL") {
        throw new SporteoHttpError(
          409,
          "COURSE_CAPACITY_REACHED",
          `Enrollment blocked: '${course.title}' has reached maximum capacity (${course.current_enrollment}/${course.max_capacity}).`
        );
      }

      const newEnrollmentCount = course.current_enrollment + 1;
      const newStatus = newEnrollmentCount >= course.max_capacity ? "FULL" : "OPEN";

      const enrollment = await tx.courseEnrollment.create({
        data: {
          courseId,
          playerProfileId: player.id,
          status: "ENROLLED",
        },
      });

      const updatedCourse = await tx.coachingCourse.update({
        where: { id: courseId },
        data: {
          currentEnrollment: newEnrollmentCount,
          status: newStatus,
        },
      });

      return { enrollment, updatedCourse };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/**
 * FR-M2-05: Conflict-Free Coaching Session Reschedule
 * Checks all existing sessions and active courses on the proposed date before saving.
 */
export async function rescheduleCoachingSessionConflictFree(
  sessionUser: SessionUser,
  payload: {
    sessionId: string;
    proposedDate: string;      // YYYY-MM-DD
    proposedStartTime: string; // "HH:MM"
    proposedEndTime: string;   // "HH:MM"
    reason: string;
  }
) {
  requireRole(sessionUser, [UserRole.COACH, UserRole.PLAYER]);

  return prisma.$transaction(async (tx) => {
    const session = await tx.coachingSession.findUnique({
      where: { id: payload.sessionId },
      include: { playerProfile: true, coachProfile: true },
    });

    if (!session) {
      throw new SporteoHttpError(404, "SESSION_NOT_FOUND", "Coaching session not found.");
    }

    const targetDate = new Date(payload.proposedDate);

    // 1. Check overlapping 1-on-1 sessions for the same coach on targetDate
    // Overlap condition: existingStart < proposedEnd AND existingEnd > proposedStart
    const overlappingSessions = await tx.coachingSession.findMany({
      where: {
        coachProfileId: session.coachProfileId,
        id: { not: session.id },
        sessionDate: targetDate,
        status: { in: ["SCHEDULED", "RESCHEDULED"] },
        startTime: { lt: payload.proposedEndTime },
        endTime: { gt: payload.proposedStartTime },
      },
    });

    if (overlappingSessions.length > 0) {
      const conflict = overlappingSessions[0];
      throw new SporteoHttpError(
        409,
        "COACH_SCHEDULE_CONFLICT",
        `Reschedule blocked: Proposed slot (${payload.proposedStartTime}-${payload.proposedEndTime}) overlaps with existing session (${conflict.startTime}-${conflict.endTime}).`
      );
    }

    // 2. Check overlapping group courses taught by the same coach on that day of week
    const dayOfWeek = targetDate.getUTCDay();
    const overlappingCourses = await tx.coachingCourse.findMany({
      where: {
        coachProfileId: session.coachProfileId,
        status: { in: ["OPEN", "FULL"] },
        dayOfWeek,
        startDate: { lte: targetDate },
        endDate: { gte: targetDate },
        startTime: { lt: payload.proposedEndTime },
        endTime: { gt: payload.proposedStartTime },
      },
    });

    if (overlappingCourses.length > 0) {
      const courseConflict = overlappingCourses[0];
      throw new SporteoHttpError(
        409,
        "COACH_COURSE_CONFLICT",
        `Reschedule blocked: Proposed slot overlaps with group course '${courseConflict.title}' (${courseConflict.startTime}-${courseConflict.endTime}).`
      );
    }

    // 3. Record Reschedule Proposal & Update Session Slot
    const proposal = await tx.rescheduleProposal.create({
      data: {
        sessionId: session.id,
        proposedByUserId: sessionUser.id,
        proposedDate: targetDate,
        proposedStartTime: payload.proposedStartTime,
        proposedEndTime: payload.proposedEndTime,
        reason: payload.reason,
        status: "APPLIED",
      },
    });

    const updatedSession = await tx.coachingSession.update({
      where: { id: session.id },
      data: {
        sessionDate: targetDate,
        startTime: payload.proposedStartTime,
        endTime: payload.proposedEndTime,
        status: "RESCHEDULED",
      },
    });

    // 4. Trigger Event Notification to Player (Module 4)
    await dispatchPlatformNotification(tx, {
      recipientUserId: session.playerProfile.userId,
      eventType: "SESSION_RESCHEDULED",
      title: "Coaching Session Rescheduled",
      body: `Your session has been rescheduled to ${payload.proposedDate} (${payload.proposedStartTime}–${payload.proposedEndTime}) with zero schedule conflicts.`,
      actionUrl: `/player/sessions/${session.id}`,
    });

    return { updatedSession, proposal };
  });
}

// ============================================================================
// MODULE 3: KPVM Pathirana (245073E)
// Venue Reservations & Inter-Club Match Coordination
// ============================================================================
// 40% Demo Requirement:
// 1. Two users attempt to reserve the same court and time slot concurrently;
//    only one succeeds while the other is blocked.
// 2. An accepted inter-club match invitation is linked to a valid confirmed venue booking.

/**
 * FR-M3-03: Concurrent Court Reservation with Pessimistic Row Locking & Serializable Isolation
 */
export async function reserveFacilityCourtConcurrently(
  sessionUser: SessionUser,
  payload: {
    facilityCourtId: string;
    clubId?: string;
    reservationDate: string; // YYYY-MM-DD
    startTime: string;       // "HH:MM"
    endTime: string;         // "HH:MM"
  }
) {
  requireRole(sessionUser, [UserRole.PLAYER, UserRole.CLUB_MANAGER]);

  return prisma.$transaction(
    async (tx) => {
      // 1. Lock the target FacilityCourt row first so concurrent requests for the same court serialize
      const lockedCourts = await tx.$queryRaw<
        Array<{ id: string; court_name: string; hourly_rate_lkr: Prisma.Decimal; is_active: boolean }>
      >`
        SELECT id, court_name, hourly_rate_lkr, is_active
        FROM facility_courts
        WHERE id = ${payload.facilityCourtId}::uuid
        FOR UPDATE
      `;

      const court = lockedCourts[0];
      if (!court || !court.is_active) {
        throw new SporteoHttpError(404, "COURT_UNAVAILABLE", "Facility court not found or inactive.");
      }

      const targetDate = new Date(payload.reservationDate);

      // 2. Check for maintenance closures overlapping the requested slot
      const closure = await tx.maintenanceClosure.findFirst({
        where: {
          facilityCourtId: payload.facilityCourtId,
          closureDate: targetDate,
          startTime: { lt: payload.endTime },
          endTime: { gt: payload.startTime },
        },
      });

      if (closure) {
        throw new SporteoHttpError(
          409,
          "MAINTENANCE_CLOSURE",
          `Court '${court.court_name}' is closed for maintenance (${closure.startTime}-${closure.endTime}): ${closure.reason}`
        );
      }

      // 3. Check for any overlapping HELD or CONFIRMED reservation
      const conflictingReservation = await tx.venueReservation.findFirst({
        where: {
          facilityCourtId: payload.facilityCourtId,
          reservationDate: targetDate,
          status: { in: ["HELD", "CONFIRMED"] },
          startTime: { lt: payload.endTime },
          endTime: { gt: payload.startTime },
        },
      });

      if (conflictingReservation) {
        throw new SporteoHttpError(
          409,
          "SLOT_ALREADY_RESERVED",
          `Double-booking prevented: Court '${court.court_name}' is already reserved on ${payload.reservationDate} for ${conflictingReservation.startTime}-${conflictingReservation.endTime}.`
        );
      }

      // 4. Create the reservation
      const reservation = await tx.venueReservation.create({
        data: {
          facilityCourtId: payload.facilityCourtId,
          bookedByUserId: sessionUser.id,
          clubId: payload.clubId ?? null,
          reservationDate: targetDate,
          startTime: payload.startTime,
          endTime: payload.endTime,
          totalAmountLkr: court.hourly_rate_lkr,
          status: "CONFIRMED",
        },
      });

      return reservation;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/**
 * FR-M3-05: Send & Accept Inter-Club Match Invitation Linked to Confirmed Venue Booking
 */
export async function createAndLinkInterClubMatch(
  sessionUser: SessionUser,
  payload: {
    hostClubId: string;
    visitingClubId: string;
    venueReservationId: string;
    sportName: SportType;
    matchTitle: string;
  }
) {
  const hostManager = requireRole(sessionUser, [UserRole.CLUB_MANAGER]);

  return prisma.$transaction(async (tx) => {
    const reservation = await tx.venueReservation.findUnique({
      where: { id: payload.venueReservationId },
      include: { facilityCourt: { include: { venue: true } } },
    });

    if (!reservation || reservation.status !== "CONFIRMED") {
      throw new SporteoHttpError(
        422,
        "UNCONFIRMED_VENUE_BOOKING",
        "Inter-club match invitations must be linked to a valid CONFIRMED venue reservation."
      );
    }

    if (reservation.bookedByUserId !== hostManager.id && reservation.clubId !== payload.hostClubId) {
      throw new SporteoHttpError(
        403,
        "RESERVATION_OWNERSHIP_MISMATCH",
        "The linked venue reservation does not belong to the Host Sports Club."
      );
    }

    const visitingClub = await tx.sportsClub.findUnique({
      where: { id: payload.visitingClubId },
    });
    if (!visitingClub) {
      throw new SporteoHttpError(404, "VISITING_CLUB_NOT_FOUND", "Visiting club not found.");
    }

    const invitation = await tx.interClubMatchInvitation.create({
      data: {
        hostClubId: payload.hostClubId,
        visitingClubId: payload.visitingClubId,
        venueReservationId: payload.venueReservationId,
        sportName: payload.sportName,
        matchTitle: payload.matchTitle,
        status: "PENDING_ACCEPTANCE",
      },
    });

    await dispatchPlatformNotification(tx, {
      recipientUserId: visitingClub.managerUserId,
      eventType: "INTER_CLUB_MATCH_INVITE",
      title: `Match Invitation: ${payload.matchTitle}`,
      body: `You have been invited to an inter-club ${payload.sportName} match at ${reservation.facilityCourt.venue.venueName} (${reservation.facilityCourt.courtName}).`,
      actionUrl: `/clubs/matches/${invitation.id}`,
    });

    return invitation;
  });
}

export async function acceptInterClubMatchInvitation(
  sessionUser: SessionUser,
  invitationId: string
) {
  const visitingManager = requireRole(sessionUser, [UserRole.CLUB_MANAGER]);

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.interClubMatchInvitation.findUnique({
      where: { id: invitationId },
      include: {
        visitingClub: true,
        hostClub: true,
        venueReservation: true,
      },
    });

    if (!invitation) {
      throw new SporteoHttpError(404, "MATCH_INVITE_NOT_FOUND", "Match invitation not found.");
    }
    if (invitation.visitingClub.managerUserId !== visitingManager.id) {
      throw new SporteoHttpError(403, "NOT_VISITING_CLUB_MANAGER", "Only the visiting club manager can accept this match.");
    }
    if (invitation.venueReservation.status !== "CONFIRMED") {
      throw new SporteoHttpError(422, "LINKED_BOOKING_NO_LONGER_CONFIRMED", "Underlying venue reservation is no longer confirmed.");
    }

    const confirmedMatch = await tx.interClubMatchInvitation.update({
      where: { id: invitationId },
      data: {
        status: "CONFIRMED_SCHEDULED",
        respondedAt: new Date(),
      },
    });

    await dispatchPlatformNotification(tx, {
      recipientUserId: invitation.hostClub.managerUserId,
      eventType: "INTER_CLUB_MATCH_CONFIRMED",
      title: `Match Accepted: ${invitation.matchTitle}`,
      body: `${invitation.visitingClub.clubName} accepted your match invitation linked to reservation #${invitation.venueReservationId.slice(0, 8)}.`,
      actionUrl: `/clubs/matches/${invitation.id}`,
    });

    return confirmedMatch;
  });
}

// ============================================================================
// MODULE 4: WMSD Weerasingha (245115R)
// Explainable Coach Discovery, Grounded AI Sports Assistant & Notifications
// ============================================================================
// 40% Demo Requirement:
// 1. Search results explicitly explain WHY coaches match the player's criteria.
// 2. The AI assistant answers from approved content and politely states when
//    info is unavailable (never mutating bookings/payments).

function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface ExplainableCoachResult {
  coachProfileId: string;
  coachName: string;
  city: string;
  hourlyRateLkr: number;
  averageRating: number;
  matchScore: number; // 0 - 100
  explanationReasons: string[];
}

/**
 * FR-M4-01 & FR-M4-02: Read-Only Multi-Filter Coach Search with Explainable Ranking
 */
export async function searchCoachesWithExplainableRanking(query: {
  sportName: SportType;
  skillLevel?: SkillLevel;
  maxHourlyBudgetLkr?: number;
  desiredDayOfWeek?: number;
  desiredTimeSlot?: string; // "HH:MM"
  playerLat?: number;
  playerLng?: number;
  maxDistanceKm?: number;
}): Promise<ExplainableCoachResult[]> {
  // Strictly READ-ONLY query on Module 2 tables
  const candidates = await prisma.coachProfile.findMany({
    where: {
      specializations: {
        some: {
          sportName: query.sportName,
        },
      },
    },
    include: {
      user: { select: { fullName: true } },
      specializations: true,
      recurringAvailabilities: { where: { isActive: true } },
    },
  });

  const rankedResults: ExplainableCoachResult[] = [];

  for (const coach of candidates) {
    let totalScore = 0;
    const reasons: string[] = [];
    const hourlyRate = Number(coach.hourlyRateLkr);

    // 1. Sport & Skill Level Specialization Match (35 points max)
    const exactSpec = coach.specializations.find(
      (s) => s.sportName === query.sportName && (!query.skillLevel || s.skillLevel === query.skillLevel)
    );
    if (exactSpec) {
      totalScore += 35;
      reasons.push(
        `Matches ${query.sportName} (${exactSpec.focusArea} – ${exactSpec.skillLevel} level) (+35%)`
      );
    } else {
      totalScore += 22;
      reasons.push(`Certified in ${query.sportName} coaching (+22%)`);
    }

    // 2. Recurring Availability Alignment (25 points max)
    if (query.desiredDayOfWeek !== undefined) {
      const matchingSlot = coach.recurringAvailabilities.find(
        (slot) =>
          slot.dayOfWeek === query.desiredDayOfWeek &&
          (!query.desiredTimeSlot ||
            (slot.startTime <= query.desiredTimeSlot && slot.endTime > query.desiredTimeSlot))
      );
      if (matchingSlot) {
        totalScore += 25;
        reasons.push(
          `Available on requested day/time window (${matchingSlot.startTime}–${matchingSlot.endTime}) (+25%)`
        );
      }
    } else if (coach.recurringAvailabilities.length > 0) {
      totalScore += 18;
      reasons.push(`Publishes ${coach.recurringAvailabilities.length} active weekly availability slots (+18%)`);
    }

    // 3. Budget / Hourly Fee Fit (20 points max)
    if (query.maxHourlyBudgetLkr !== undefined) {
      if (hourlyRate <= query.maxHourlyBudgetLkr) {
        totalScore += 20;
        const savings = Math.round(((query.maxHourlyBudgetLkr - hourlyRate) / query.maxHourlyBudgetLkr) * 100);
        reasons.push(
          `Hourly fee LKR ${hourlyRate.toLocaleString()} is within your LKR ${query.maxHourlyBudgetLkr.toLocaleString()} budget (${savings}% below cap) (+20%)`
        );
      } else {
        reasons.push(`Hourly fee LKR ${hourlyRate.toLocaleString()} exceeds target budget (+0%)`);
      }
    } else {
      totalScore += 15;
    }

    // 4. Geospatial Proximity (10 points max)
    if (query.playerLat !== undefined && query.playerLng !== undefined) {
      const distKm = haversineDistanceKm(
        query.playerLat,
        query.playerLng,
        Number(coach.latitude),
        Number(coach.longitude)
      );
      const maxRadius = query.maxDistanceKm ?? 25;
      if (distKm <= maxRadius) {
        const proxScore = Math.max(4, Math.round(10 * (1 - distKm / (maxRadius * 1.5))));
        totalScore += proxScore;
        reasons.push(`Located ${distKm.toFixed(1)} km away in ${coach.city} (+${proxScore}%)`);
      }
    } else {
      totalScore += 8;
      reasons.push(`Based in ${coach.city}, ${coach.district} (+8%)`);
    }

    // 5. Verified Player Rating & Experience (10 points max)
    const rating = Number(coach.averageRating);
    const ratingScore = Math.min(10, Math.round((rating / 5) * 7 + Math.min(3, coach.yearsExperience / 3)));
    totalScore += ratingScore;
    reasons.push(
      `Rated ${rating.toFixed(1)}/5.0 (${coach.reviewCount} reviews) with ${coach.yearsExperience} yrs experience (+${ratingScore}%)`
    );

    rankedResults.push({
      coachProfileId: coach.id,
      coachName: coach.user.fullName,
      city: coach.city,
      hourlyRateLkr: hourlyRate,
      averageRating: rating,
      matchScore: Math.min(100, totalScore),
      explanationReasons: reasons,
    });
  }

  return rankedResults.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * FR-M4-04: Strictly Grounded RAG Sports Assistant
 * Enforces read-only boundary (blocks booking/payment mutations) and similarity threshold (>= 0.75).
 */
const MUTATION_INTENT_REGEX = /\b(cancel my booking|refund my payment|book this court|charge my card|change my password)\b/i;

export async function askGroundedSportsAssistant(
  sessionUser: SessionUser,
  payload: {
    conversationId: string;
    question: string;
    queryEmbeddingVector: number[];
  }
) {
  // 1. Enforce Module 4 Boundary: Chatbot cannot mutate bookings or payments
  if (MUTATION_INTENT_REGEX.test(payload.question)) {
    return prisma.chatMessage.create({
      data: {
        conversationId: payload.conversationId,
        senderRole: "ASSISTANT",
        messageText:
          "I am a read-only sports and platform assistant and cannot directly create, modify, or cancel bookings or payments. Please use the Bookings or Payments dashboard to manage your reservations.",
        isGrounded: false,
        confidenceScore: new Prisma.Decimal(1.0),
        citedDocumentIds: [],
      },
    });
  }

  const vectorLiteral = `[${payload.queryEmbeddingVector.join(",")}]`;

  // 2. Retrieve Top Approved Knowledge Chunks via pgvector Cosine Similarity
  const retrievedChunks = await prisma.$queryRaw<
    Array<{
      chunk_id: string;
      document_id: string;
      title: string;
      chunk_text: string;
      similarity: number;
    }>
  >`
    SELECT
      c.id AS chunk_id,
      d.id AS document_id,
      d.title,
      c.chunk_text,
      1 - (c.embedding_vector <=> ${vectorLiteral}::vector) AS similarity
    FROM knowledge_chunk_embeddings c
    INNER JOIN knowledge_documents d ON d.id = c.document_id
    WHERE d.is_approved = true
    ORDER BY c.embedding_vector <=> ${vectorLiteral}::vector ASC
    LIMIT 3
  `;

  const topSimilarity = retrievedChunks[0]?.similarity ?? 0;

  // 3. Enforce Strict Grounding Threshold (>= 0.75)
  if (retrievedChunks.length === 0 || topSimilarity < 0.75) {
    return prisma.chatMessage.create({
      data: {
        conversationId: payload.conversationId,
        senderRole: "ASSISTANT",
        messageText:
          "I'm sorry, I don't have verified information on that topic in Sporteo's approved sports and platform knowledge base. Please ask about Cricket, Rugby, Football, Badminton rules, training guidelines, or Sporteo platform workflows.",
        isGrounded: false,
        confidenceScore: new Prisma.Decimal(Number(topSimilarity.toFixed(3))),
        citedDocumentIds: [],
      },
    });
  }

  // 4. Synthesize Grounded Response Citing Approved Sources Only
  const citations = Array.from(new Set(retrievedChunks.map((c) => c.title)));
  const synthesizedContext = retrievedChunks.map((c) => c.chunk_text).join(" ");
  const groundedReply = `Based on Sporteo's verified guide (${citations.join(", ")}): ${synthesizedContext}`;

  return prisma.chatMessage.create({
    data: {
      conversationId: payload.conversationId,
      senderRole: "ASSISTANT",
      messageText: groundedReply,
      isGrounded: true,
      confidenceScore: new Prisma.Decimal(Number(topSimilarity.toFixed(3))),
      citedDocumentIds: retrievedChunks.map((c) => c.document_id),
    },
  });
}

// ============================================================================
// MODULE 5: AMT Mandinu (245062U)
// Payments, Commissions, Refunds & Financial Reporting
// ============================================================================
// 40% Demo Requirement:
// 1. A sandbox payment confirms a booking and splits the 10% commission.
// 2. Repeated payment webhook notifications do not create duplicate charges.
// 3. A cancellation computes the proper refund and commission outcome.

/**
 * FR-M5-02 & FR-M5-03: Idempotent Sandbox Webhook Processor & 10% Commission Split
 */
export async function processSandboxPaymentWebhook(payload: {
  gatewayEventId: string;
  paymentOrderId: string;
  gatewayPaymentId: string;
  gatewayName: "STRIPE_SANDBOX" | "PAYHERE_SANDBOX";
  amountPaidLkr: number;
}) {
  return prisma.$transaction(
    async (tx) => {
      // 1. Idempotency Guard: Check if gatewayEventId was already processed
      const existingWebhook = await tx.webhookEventLog.findUnique({
        where: { gatewayEventId: payload.gatewayEventId },
      });

      if (existingWebhook) {
        const updatedWebhook = await tx.webhookEventLog.update({
          where: { id: existingWebhook.id },
          data: {
            duplicateDeliveryCount: { increment: 1 },
            lastReceivedAt: new Date(),
          },
        });

        return {
          idempotentReplay: true,
          statusCode: 200,
          message: `Duplicate webhook '${payload.gatewayEventId}' safely ignored (delivery #${updatedWebhook.duplicateDeliveryCount + 1}). Zero duplicate charges created.`,
          webhookLog: updatedWebhook,
        };
      }

      // 2. Fetch PaymentOrder
      const order = await tx.paymentOrder.findUnique({
        where: { id: payload.paymentOrderId },
      });
      if (!order) {
        throw new SporteoHttpError(404, "ORDER_NOT_FOUND", "PaymentOrder not found.");
      }

      // 3. Log First Webhook Delivery
      const webhookLog = await tx.webhookEventLog.create({
        data: {
          gatewayEventId: payload.gatewayEventId,
          paymentOrderId: order.id,
          eventType: "PAYMENT_SUCCEEDED",
          duplicateDeliveryCount: 0,
        },
      });

      // 4. Record PaymentTransaction & Mark Order PAID
      const transaction = await tx.paymentTransaction.create({
        data: {
          paymentOrderId: order.id,
          gatewayName: payload.gatewayName,
          gatewayPaymentId: payload.gatewayPaymentId,
          amountPaidLkr: new Prisma.Decimal(payload.amountPaidLkr),
          currency: "LKR",
        },
      });

      await tx.paymentOrder.update({
        where: { id: order.id },
        data: { status: "PAID" },
      });

      // 5. Fetch Active Platform Commission Rate (Default 10.00%)
      const activeConfig = await tx.commissionConfig.findFirst({
        where: { isActive: true },
        orderBy: { effectiveFrom: "desc" },
      });
      const commissionRatePct = activeConfig ? Number(activeConfig.commissionPercentage) : 10.0;

      const gross = Number(order.netPayableLkr);
      const platformCommission = Number(((gross * commissionRatePct) / 100).toFixed(2));
      const providerNet = Number((gross - platformCommission).toFixed(2));

      const ledgerEntry = await tx.commissionLedgerEntry.create({
        data: {
          paymentOrderId: order.id,
          providerUserId: order.providerUserId,
          grossAmountLkr: new Prisma.Decimal(gross),
          commissionRatePct: new Prisma.Decimal(commissionRatePct),
          platformCommissionLkr: new Prisma.Decimal(platformCommission),
          providerNetEarningsLkr: new Prisma.Decimal(providerNet),
          adjustedCommissionLkr: new Prisma.Decimal(platformCommission),
          adjustedProviderNetLkr: new Prisma.Decimal(providerNet),
        },
      });

      // 6. Confirm Underlying Booking in Module 2 or Module 3
      if (order.bookingType === "VENUE_RESERVATION") {
        await tx.venueReservation.update({
          where: { id: order.bookingReferenceId },
          data: { status: "CONFIRMED" },
        });
      } else if (order.bookingType === "COACHING_SESSION") {
        await tx.coachingSession.update({
          where: { id: order.bookingReferenceId },
          data: { status: "SCHEDULED" },
        });
      }

      // 7. Notify Payer (Module 4)
      await dispatchPlatformNotification(tx, {
        recipientUserId: order.payerUserId,
        eventType: "PAYMENT_CONFIRMED",
        title: "Booking Payment Confirmed",
        body: `Your payment of LKR ${gross.toLocaleString()} was processed. Booking #${order.bookingReferenceId.slice(0, 8)} is confirmed.`,
        actionUrl: `/player/payments/${order.id}`,
      });

      return {
        idempotentReplay: false,
        statusCode: 200,
        transaction,
        ledgerEntry,
        webhookLog,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
  );
}

/**
 * FR-M5-05: Policy-Driven Booking Cancellation Refund & Commission Outcome Calculation
 * Cancellation Policy Tiers:
 * - >= 48 hours before start: 100% refund
 * - 24 to < 48 hours before start: 50% refund
 * - < 24 hours before start: 0% refund
 */
export async function processCancellationRefundAndCommissionAdjustment(
  sessionUser: SessionUser,
  payload: {
    paymentOrderId: string;
    hoursUntilBookingStart: number;
  }
) {
  requireRole(sessionUser, [UserRole.PLAYER, UserRole.SYSTEM_ADMIN]);

  return prisma.$transaction(async (tx) => {
    const order = await tx.paymentOrder.findUnique({
      where: { id: payload.paymentOrderId },
      include: { commissionLedger: true },
    });

    if (!order || order.status !== "PAID" || !order.commissionLedger) {
      throw new SporteoHttpError(
        422,
        "ORDER_NOT_REFUNDABLE",
        "Only PAID orders with an active commission ledger entry can be refunded."
      );
    }

    // Determine Cancellation Policy Tier
    let refundTierPct = 0;
    if (payload.hoursUntilBookingStart >= 48) {
      refundTierPct = 100;
    } else if (payload.hoursUntilBookingStart >= 24) {
      refundTierPct = 50;
    } else {
      refundTierPct = 0;
    }

    const gross = Number(order.commissionLedger.grossAmountLkr);
    const ratePct = Number(order.commissionLedger.commissionRatePct); // 10%
    const refundAmount = Number(((gross * refundTierPct) / 100).toFixed(2));
    const retainedGross = Number((gross - refundAmount).toFixed(2));

    // Recompute commission and provider net on retained gross
    const adjustedCommission = Number(((retainedGross * ratePct) / 100).toFixed(2));
    const adjustedProviderNet = Number((retainedGross - adjustedCommission).toFixed(2));

    const commissionReversed = Number(
      (Number(order.commissionLedger.platformCommissionLkr) - adjustedCommission).toFixed(2)
    );
    const providerShareDeducted = Number(
      (Number(order.commissionLedger.providerNetEarningsLkr) - adjustedProviderNet).toFixed(2)
    );

    const refundRecord = await tx.refundRecord.create({
      data: {
        paymentOrderId: order.id,
        cancellationTierPct: new Prisma.Decimal(refundTierPct),
        refundAmountLkr: new Prisma.Decimal(refundAmount),
        commissionReversedLkr: new Prisma.Decimal(commissionReversed),
        providerShareDeductedLkr: new Prisma.Decimal(providerShareDeducted),
        gatewayRefundId: `re_sandbox_${order.id.slice(0, 8)}`,
      },
    });

    const updatedLedger = await tx.commissionLedgerEntry.update({
      where: { id: order.commissionLedger.id },
      data: {
        adjustedCommissionLkr: new Prisma.Decimal(adjustedCommission),
        adjustedProviderNetLkr: new Prisma.Decimal(adjustedProviderNet),
      },
    });

    const newPaymentStatus = refundTierPct === 100 ? "REFUNDED" : refundTierPct > 0 ? "PARTIALLY_REFUNDED" : "PAID";
    await tx.paymentOrder.update({
      where: { id: order.id },
      data: { status: newPaymentStatus },
    });

    return {
      refundTierPct,
      refundAmountLkr: refundAmount,
      retainedGrossLkr: retainedGross,
      adjustedPlatformCommissionLkr: adjustedCommission,
      adjustedProviderNetLkr: adjustedProviderNet,
      refundRecord,
      updatedLedger,
    };
  });
}