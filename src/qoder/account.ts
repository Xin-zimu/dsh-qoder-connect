/** Browser-safe Qoder subscriber account and quota types. */

export interface QoderSubscriberProfile {
  id: string
  name: string
  email: string
}

export interface QoderQuota {
  total: number
  used: number
  remaining: number
  percentage: number
  unit: string
}

/**
 * A named grant of credits that expires on its own schedule, reported in the
 * international upstream's `dedicatedResourcePackages`.
 */
export interface QoderDedicatedResourcePackage extends QoderQuota {
  /** Upstream package id (`01a1426f-…`), when reported. */
  id?: string | undefined
  /** Raw upstream name — usually an opaque campaign code, not display copy. */
  name?: string | undefined
  /** Localized display title from `displayLabels`, when the upstream sends one. */
  title?: { zh?: string | undefined; en?: string | undefined } | undefined
  /** This package's own expiry, ISO; not the account's cycle-level date. */
  expiresAt?: string | undefined
  /** Whether the upstream says the package is currently usable. */
  available?: boolean | undefined
  /** Upstream lifecycle marker (`QUOTA_DETAIL_STATUS_ACTIVE`). */
  status?: string | undefined
}

export interface QoderQuotaUsage {
  userQuota?: QoderQuota | undefined
  orgResourcePackage?: QoderQuota | undefined
  /** Credits granted on top of the plan, with their own total and remaining. */
  addOnQuota?: QoderQuota | undefined
  /** Campaign grants carrying their own expiry and display title. */
  dedicatedResourcePackages?: readonly QoderDedicatedResourcePackage[] | undefined
  totalUsagePercentage?: number | undefined
  isQuotaExceeded?: boolean | undefined
  expiresAt?: string | undefined
  raw?: unknown
}

export interface QoderSubscriberOrganization {
  orgId: string
  orgName: string
  roleName?: string | undefined
  isSuspended?: boolean
  canManageSubscriptions?: boolean
  resourcePackageFeatureEnabled?: boolean
}

export interface QoderSubscriberFeatureAllowed {
  quest?: boolean
  wiki?: boolean
  codeReview?: boolean
}

export interface QoderSubscriberPlan {
  userType: string
  planTierName: string
  planTier?: string
  isPersonalVersion: boolean
  isHighestTier?: boolean
  isRenewed?: boolean
  startDate?: string
  endDate?: string
  organization?: QoderSubscriberOrganization
  featureAllowed?: QoderSubscriberFeatureAllowed
  raw?: unknown
}

export interface QoderSubscriberStatus {
  allowByok: number
  teamAllowByok?: number
  isPrivacyPolicyModifiable?: boolean
  raw?: unknown
}

export interface QoderAccountInfo {
  profile: QoderSubscriberProfile
  usage?: QoderQuotaUsage
  plan?: QoderSubscriberPlan
  status?: QoderSubscriberStatus
  updatedAt: string
}
