import { Registerable } from '@supertask/modules/core/registry'
import NotificationSenderInitialsIcon from '@supertask/modules/core/components/notifications/NotificationSenderInitialsIcon'
import WorkspaceInvitationCreatedNotification from '@supertask/modules/core/components/notifications/WorkspaceInvitationCreatedNotification'
import WorkspaceInvitationAcceptedNotification from '@supertask/modules/core/components/notifications/WorkspaceInvitationAcceptedNotification'
import WorkspaceInvitationRejectedNotification from '@supertask/modules/core/components/notifications/WorkspaceInvitationRejectedNotification'
import SupertaskVersionUpgradeNotification from '@supertask/modules/core/components/notifications/SupertaskVersionUpgradeNotification'
import NotificationImgIcon from '@supertask/modules/core/components/notifications/NotificationImgIcon'
import SupertaskIcon from '@supertask/modules/core/static/img/logoOnly.svg?url'

export class NotificationType extends Registerable {
  getIconComponent() {
    throw new Error('getIconComponent not implemented')
  }

  getContentComponent() {
    throw new Error('getContentComponent not implemented')
  }

  getIconComponentProps() {
    return {}
  }

  /**
   * Should return the nuxt route of the page where to redirect to if the user clicks
   * on the notification. Note that the backend also uses this to create a link in
   * external communication like the email, and if anything changes in this method,
   * the `safe_route_data_parameters` then might need to be updated as well. If
   * `null` is returned, it means that the notification is not clickable.
   */
  getRoute(notificationData) {
    return null
  }
}

export class WorkspaceInvitationCreatedNotificationType extends NotificationType {
  static getType() {
    return 'workspace_invitation_created'
  }

  getIconComponent() {
    return NotificationSenderInitialsIcon
  }

  getContentComponent() {
    return WorkspaceInvitationCreatedNotification
  }

  getRoute(notificationData) {
    return { name: 'dashboard' }
  }
}

export class WorkspaceInvitationAcceptedNotificationType extends NotificationType {
  static getType() {
    return 'workspace_invitation_accepted'
  }

  getIconComponent() {
    return NotificationSenderInitialsIcon
  }

  getContentComponent() {
    return WorkspaceInvitationAcceptedNotification
  }
}

export class WorkspaceInvitationRejectedNotificationType extends NotificationType {
  static getType() {
    return 'workspace_invitation_rejected'
  }

  getIconComponent() {
    return NotificationSenderInitialsIcon
  }

  getContentComponent() {
    return WorkspaceInvitationRejectedNotification
  }
}

export class SupertaskVersionUpgradeNotificationType extends NotificationType {
  static getType() {
    return 'supertask_version_upgrade'
  }

  getIconComponent() {
    return NotificationImgIcon
  }

  getIconComponentProps() {
    return { icon: SupertaskIcon }
  }

  getContentComponent() {
    return SupertaskVersionUpgradeNotification
  }
}
