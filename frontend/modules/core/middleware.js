import settings from '@supertask/modules/core/middleware/settings'
import authentication from '@supertask/modules/core/middleware/authentication'
import authenticated from '@supertask/modules/core/middleware/authenticated'
import staff from '@supertask/modules/core/middleware/staff'
import workspacesAndApplications from '@supertask/modules/core/middleware/workspacesAndApplications'
import pendingJobs from '@supertask/modules/core/middleware/pendingJobs'
import urlCheck from '@supertask/modules/core/middleware/urlCheck'
import impersonate from '@supertask/modules/core/middleware/impersonate'

import Middleware from './middleware'

Middleware.settings = settings
Middleware.authentication = authentication
Middleware.authenticated = authenticated
Middleware.staff = staff
Middleware.workspacesAndApplications = workspacesAndApplications
Middleware.pendingJobs = pendingJobs
Middleware.urlCheck = urlCheck
Middleware.impersonate = impersonate
