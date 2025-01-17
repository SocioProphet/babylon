const parseDuration = require('parse-duration');

import {
  AnarchyAction,
  AnarchyGovernor,
  AnarchySubject,
  AnarchyRun,
  CatalogItem,
  CatalogItemList,
  JSONPatch,
  K8sObject,
  K8sObjectList,
  NamespaceList,
  ResourceClaim,
  ResourceClaimList,
  ResourceClaimSpecResource,
  ResourceHandle,
  ResourceHandleList,
  ResourcePool,
  ResourcePoolList,
  ResourceProvider,
  ResourceProviderList,
  ServiceNamespace,
  Workshop,
  WorkshopList,
  WorkshopProvision,
  WorkshopProvisionList,
  WorkshopSpecUserAssignment,
  UserList,
} from '@app/types';

import {
  store,
  apiActionDeleteResourceClaim,
  apiActionInsertResourceClaim,
  apiActionUpdateResourceClaim,
} from '@app/store';

import { selectImpersonationUser, selectUserGroups, selectUserNamespace } from '@app/store';

import { checkAccessControl, displayName, recursiveAssign, BABYLON_DOMAIN } from '@app/util';

declare var window: Window &
  typeof globalThis & {
    apiSessionPromise?: any;
    apiSessionInterval?: any;
    apiSessionImpersonateUser?: any;
  };

export interface CreateServiceRequestOpt {
  catalogItem: any;
  catalogNamespace: any;
  parameterValues?: CreateServiceRequestParameterValues;
}

export interface CreateServiceRequestParameterValues {
  [name: string]: boolean | number | string;
}

export interface K8sApiFetchOpt {
  disableImpersonation?: boolean;
}

export interface K8sObjectListCommonOpt {
  continue?: string;
  disableImpersonation?: boolean;
  labelSelector?: string;
  limit?: number;
  namespace?: string;
}

export interface K8sObjectListOpt extends K8sObjectListCommonOpt {
  apiVersion: string;
  plural: string;
}

async function apiFetch(path: string, opt?: object): Promise<any> {
  const session = await getApiSession();

  const options = opt ? JSON.parse(JSON.stringify(opt)) : {};
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.headers.Authentication = `Bearer ${session.token}`;

  if (!options.disableImpersonation) {
    const impersonateUser = selectImpersonationUser(store.getState());
    if (impersonateUser) {
      options.headers['Impersonate-User'] = impersonateUser;
    }
  }

  const resp = await fetch(path, options);
  if (resp.status >= 400 && resp.status < 600) {
    throw resp;
  }

  return resp;
}

export async function assignWorkshopUser({
  resourceClaimName,
  userName,
  email,
  workshop,
}: {
  resourceClaimName: string;
  userName: string;
  email: string;
  workshop: Workshop;
}): Promise<Workshop> {
  const userAssignmentIdx: number = workshop.spec.userAssignments.findIndex(
    (item) => resourceClaimName === item.resourceClaimName && userName === item.userName
  );
  const userAssignment: WorkshopSpecUserAssignment = workshop.spec.userAssignments[userAssignmentIdx];
  if (!userAssignment) {
    console.error(`Unable to assign, ${resourceClaimName} ${userName} not found.`);
    return workshop;
  } else if (userAssignment.assignment?.email === email || (!userAssignment.assignment?.email && !email)) {
    return workshop;
  }

  const jsonPatch: JSONPatch = [];
  if (resourceClaimName) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/resourceClaimName`,
      value: resourceClaimName,
    });
  }
  if (userName) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/userName`,
      value: userName,
    });
  }
  if (userAssignment.assignment) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/assignment/email`,
      value: workshop.spec.userAssignments[userAssignmentIdx].assignment.email,
    });
    if (email) {
      jsonPatch.push({
        op: 'replace',
        path: `/spec/userAssignments/${userAssignmentIdx}/assignment/email`,
        value: email,
      });
    } else {
      jsonPatch.push({
        op: 'remove',
        path: `/spec/userAssignments/${userAssignmentIdx}/assignment`,
      });
    }
  } else if (email) {
    jsonPatch.push({
      op: 'add',
      path: `/spec/userAssignments/${userAssignmentIdx}/assignment`,
      value: { email: email },
    });
  } else {
    return workshop;
  }

  const updatedWorkshop: Workshop = await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    jsonPatch: jsonPatch,
  });
  return updatedWorkshop;
}

export async function bulkAssignWorkshopUsers({
  emails,
  workshop,
}: {
  emails: string[];
  workshop: Workshop;
}): Promise<{ unassignedEmails: string[]; userAssignments: WorkshopSpecUserAssignment[]; workshop: Workshop }> {
  if (!workshop.spec.userAssignments) {
    return {
      unassignedEmails: emails,
      userAssignments: [],
      workshop: workshop,
    };
  }

  let _workshop: Workshop = workshop;
  while (true) {
    const userAssignments: WorkshopSpecUserAssignment[] = [];
    const unassignedEmails: string[] = [];
    for (const email of emails) {
      const userAssignment = _workshop.spec.userAssignments.find((item) => item.assignment?.email === email);
      if (userAssignment) {
        userAssignments.push(userAssignment);
      } else {
        unassignedEmails.push(email);
      }
    }
    for (const userAssignment of _workshop.spec.userAssignments) {
      if (!userAssignment.assignment) {
        userAssignment.assignment = {
          email: unassignedEmails.shift(),
        };
        userAssignments.push(userAssignment);
      }
      if (unassignedEmails.length === 0) {
        break;
      }
    }
    try {
      _workshop = await updateWorkshop(_workshop);
      return {
        unassignedEmails: unassignedEmails,
        userAssignments: userAssignments,
        workshop: _workshop,
      };
    } catch (error: any) {
      if (error.status === 409) {
        _workshop = await getWorkshop(workshop.metadata.namespace, workshop.metadata.name);
      } else {
        throw error;
      }
    }
  }
}

export async function checkSalesforceId(id: string): Promise<boolean> {
  if (!id || !id.match(/^\d{7,}$/)) {
    return false;
  }
  try {
    await apiFetch(`/api/salesforce/opportunity/${id}`);
  } catch (error) {
    return false;
  }
  return true;
}

export async function createK8sObject<Type extends K8sObject>(definition: Type): Promise<Type> {
  const apiVersion = definition.apiVersion;
  const namespace = definition.metadata.namespace;
  const plural = definition.kind.toLowerCase() + 's';

  const path = namespace ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}` : `/apis/${apiVersion}/${plural}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(definition),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  return await resp.json();
}

export async function createResourceClaim(definition, opt: any = {}): Promise<ResourceClaim> {
  const resourceClaim: ResourceClaim = await createK8sObject<ResourceClaim>(definition);
  if (!opt.skipUpdateStore) {
    store.dispatch(
      apiActionInsertResourceClaim({
        resourceClaim: resourceClaim,
      })
    );
  }
  return resourceClaim;
}

export async function createResourcePool(definition: ResourcePool): Promise<ResourcePool> {
  const response = await createK8sObject<ResourcePool>(definition);
  return response;
}

export async function createServiceRequest({
  catalogItem,
  catalogNamespace,
  parameterValues,
}: CreateServiceRequestOpt): Promise<any> {
  const baseUrl = window.location.href.replace(/^([^/]+\/\/[^\/]+)\/.*/, '$1');
  const session = await getApiSession();
  const userGroups = selectUserGroups(store.getState());
  const userNamespace = selectUserNamespace(store.getState());
  const access = checkAccessControl(catalogItem.spec.accessControl, userGroups);

  const requestResourceClaim: ResourceClaim = {
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    kind: 'ResourceClaim',
    metadata: {
      annotations: {
        [`${BABYLON_DOMAIN}/catalogDisplayName`]: catalogNamespace?.displayName || catalogItem.metadata.namespace,
        [`${BABYLON_DOMAIN}/catalogItemDisplayName`]: displayName(catalogItem),
        [`${BABYLON_DOMAIN}/requester`]: session.user,
        [`${BABYLON_DOMAIN}/url`]: `${baseUrl}/services/${userNamespace.name}/${catalogItem.metadata.name}`,
      },
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
      },
      name: catalogItem.metadata.name,
      namespace: userNamespace.name,
    },
    spec: {
      resources: [],
    },
  };

  if (catalogItem.spec.userData) {
    requestResourceClaim.metadata.annotations[`${BABYLON_DOMAIN}/userData`] = JSON.stringify(catalogItem.spec.userData);
  }

  if (access === 'allow') {
    // Once created the ResourceClaim is completely independent of the catalog item.
    // This allows the catalog item to be changed or removed without impacting provisioned
    // services. All relevant configuration from the CatalogItem needs to be copied into
    // the ResourceClaim.

    // Copy resources from catalog item to ResourceClaim
    requestResourceClaim.spec.resources = JSON.parse(JSON.stringify(catalogItem.spec.resources));

    // Add display name annotations for components
    for (const [key, value] of Object.entries(catalogItem.metadata.annotations || {})) {
      if (key.startsWith(`${BABYLON_DOMAIN}/displayNameComponent`)) {
        requestResourceClaim.metadata.annotations[key] = value;
      }
    }

    // Add bookbag label
    if (catalogItem.spec.bookbag) {
      requestResourceClaim.metadata.labels[`${BABYLON_DOMAIN}/labUserInterface`] = 'bookbag';
    }

    // Copy all parameter values into the ResourceClaim
    for (const parameter of catalogItem.spec.parameters || []) {
      // passed parameter value or default
      const value: boolean | number | string =
        parameterValues?.[parameter.name] !== undefined
          ? parameterValues[parameter.name]
          : parameter.openAPIV3Schema?.default !== undefined
          ? parameter.openAPIV3Schema.default
          : parameter.value;

      // Set annotation for parameter
      if (parameter.annotation && value !== undefined) {
        requestResourceClaim.metadata.annotations[parameter.annotation] = String(value);
      }

      // Job variable name is either explicitly set or defaults to the parameter name unless an annotation is given.
      const jobVarName: string = parameter.variable || (parameter.annotation ? null : parameter.name);
      if (!jobVarName) {
        continue;
      }

      // Determine to which resources in the resource claim the parameters apply
      const resourceIndexes: number[] = parameter.resourceIndexes
        ? parameter.resourceIndexes.map((i) => (i === '@' ? requestResourceClaim.spec.resources.length - 1 : i))
        : [requestResourceClaim.spec.resources.length - 1];

      for (const resourceIndex in requestResourceClaim.spec.resources) {
        // Skip this resource if resource index does not match
        if (!resourceIndexes.includes(parseInt(resourceIndex))) {
          continue;
        }

        const resource: ResourceClaimSpecResource = requestResourceClaim.spec.resources[resourceIndex];
        recursiveAssign(resource, { template: { spec: { vars: { job_vars: { [jobVarName]: value } } } } });
      }
    }
  } else {
    // No direct access to catalog item. Create the service-request to record
    // the user interest in the catalog item.
    requestResourceClaim.spec.resources[0] = {
      provider: {
        apiVersion: 'poolboy.gpte.redhat.com/v1',
        kind: 'ResourceProvider',
        name: 'babylon-service-request-configmap',
        namespace: 'poolboy',
      },
      template: {
        data: {
          catalogItemName: catalogItem.metadata.name,
          catalogItemNamespace: catalogItem.metadata.namespace,
          parameters: JSON.stringify(parameterValues),
        },
        metadata: {
          labels: {
            [`${BABYLON_DOMAIN}/catalogItem`]: catalogItem.metadata.name,
          },
        },
      },
    };
  }

  let n = 0;
  while (true) {
    try {
      const resourceClaim: ResourceClaim = await createResourceClaim(requestResourceClaim);
      return resourceClaim;
    } catch (error: any) {
      if (error.status === 409) {
        n++;
        requestResourceClaim.metadata.name = `${catalogItem.metadata.name}-${n}`;
        requestResourceClaim.metadata.annotations[
          `${BABYLON_DOMAIN}/url`
        ] = `${baseUrl}/services/${userNamespace.name}/${catalogItem.metadata.name}-${n}`;
      } else {
        throw error;
      }
    }
  }
}

export async function createWorkshop({
  accessPassword,
  catalogItem,
  description,
  displayName,
  openRegistration,
  serviceNamespace,
}: {
  accessPassword?: string;
  catalogItem: CatalogItem;
  description?: string;
  displayName?: string;
  openRegistration: boolean;
  serviceNamespace: ServiceNamespace;
}): Promise<Workshop> {
  const definition: Workshop = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'Workshop',
    metadata: {
      name: catalogItem.metadata.name,
      namespace: serviceNamespace.name,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
      },
    },
    spec: {
      multiuserServices: catalogItem.spec.multiuser,
      openRegistration: openRegistration,
      userAssignments: [],
    },
  };
  if (accessPassword) {
    definition.spec.accessPassword = accessPassword;
  }
  if (description) {
    definition.spec.description = description;
  }
  if (displayName) {
    definition.spec.displayName = displayName;
  }

  let n = 0;
  while (true) {
    try {
      const workshop: Workshop = await createK8sObject<Workshop>(definition);
      return workshop;
    } catch (error: any) {
      if (error.status === 409) {
        n++;
        definition.metadata.name = `${catalogItem.metadata.name}-${n}`;
      } else {
        throw error;
      }
    }
  }
}

export async function createWorkshopForMultiuserService({
  accessPassword,
  description,
  displayName,
  openRegistration,
  resourceClaim,
}: {
  accessPassword?: string;
  description: string;
  displayName: string;
  openRegistration: boolean;
  resourceClaim: ResourceClaim;
}): Promise<{ resourceClaim: ResourceClaim; workshop: Workshop }> {
  const catalogItemName: string = resourceClaim.metadata.labels?.[`${BABYLON_DOMAIN}/catalogItemName`];
  const catalogItemNamespace: string = resourceClaim.metadata.labels?.[`${BABYLON_DOMAIN}/catalogItemNamespace`];
  const definition: Workshop = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'Workshop',
    metadata: {
      name: resourceClaim.metadata.name,
      namespace: resourceClaim.metadata.namespace,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItemName,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItemNamespace,
      },
      ownerReferences: [
        {
          apiVersion: 'poolboy.gpte.redhat.com/v1',
          controller: true,
          kind: 'ResourceClaim',
          name: resourceClaim.metadata.name,
          uid: resourceClaim.metadata.uid,
        },
      ],
    },
    spec: {
      multiuserServices: true,
      openRegistration: openRegistration,
      provisionDisabled: true,
      userAssignments: [],
    },
  };
  if (accessPassword) {
    definition.spec.accessPassword = accessPassword;
  }
  if (description) {
    definition.spec.description = description;
  }
  if (displayName) {
    definition.spec.displayName = displayName;
  }
  // Use GUID as workshop id
  if (resourceClaim.status?.resourceHandle) {
    definition.metadata.labels[`${BABYLON_DOMAIN}/workshop-id`] = resourceClaim.status?.resourceHandle.name.replace(
      /^guid-/,
      ''
    );
  }

  const workshop: Workshop = await createK8sObject<Workshop>(definition);
  const patchedResourceClaim: ResourceClaim = await patchResourceClaim(
    resourceClaim.metadata.namespace,
    resourceClaim.metadata.name,
    {
      metadata: {
        labels: {
          [`${BABYLON_DOMAIN}/workshop`]: workshop.metadata.name,
        },
      },
    }
  );

  return { resourceClaim: patchedResourceClaim, workshop: workshop };
}

export async function createWorkshopProvision({
  catalogItem,
  concurrency,
  count,
  parameters,
  startDelay,
  workshop,
}: {
  catalogItem: CatalogItem;
  concurrency: number;
  count: number;
  parameters: any;
  startDelay: number;
  workshop: Workshop;
}): Promise<WorkshopProvision> {
  const definition: WorkshopProvision = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'WorkshopProvision',
    metadata: {
      name: workshop.metadata.name,
      namespace: workshop.metadata.namespace,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
      },
      ownerReferences: [
        {
          apiVersion: `${BABYLON_DOMAIN}/v1`,
          controller: true,
          kind: 'Workshop',
          name: workshop.metadata.name,
          uid: workshop.metadata.uid,
        },
      ],
    },
    spec: {
      catalogItem: {
        name: catalogItem.metadata.name,
        namespace: catalogItem.metadata.namespace,
      },
      concurrency: concurrency,
      count: count,
      parameters: parameters,
      startDelay: startDelay,
      workshopName: workshop.metadata.name,
    },
  };

  const workshopProvision: WorkshopProvision = await createK8sObject<WorkshopProvision>(definition);
  return workshopProvision;
}

export async function getAnarchyAction(namespace: string, name: string): Promise<AnarchyAction> {
  return (await getNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    namespace,
    'anarchyactions',
    name
  )) as AnarchyAction;
}

export async function getApiSession(): Promise<any> {
  if (!window.apiSessionPromise) {
    refreshApiSession();
  }
  const session = await window.apiSessionPromise;
  if (window.apiSessionImpersonateUser) {
    session.impersonateUser = window.apiSessionImpersonateUser;
  }
  return session;
}

export async function getAnarchyGovernor(namespace: string, name: string): Promise<AnarchyGovernor> {
  return (await getNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    namespace,
    'anarchygovernors',
    name
  )) as AnarchyGovernor;
}

export async function getAnarchyRun(namespace: string, name: string): Promise<AnarchyRun> {
  return (await getNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    namespace,
    'anarchyruns',
    name
  )) as AnarchyRun;
}

export async function getAnarchySubject(namespace: string, name: string): Promise<AnarchySubject> {
  return (await getNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    namespace,
    'anarchysubjects',
    name
  )) as AnarchySubject;
}

export async function getCatalogItem(namespace: string, name: string): Promise<CatalogItem> {
  return await getK8sObject<CatalogItem>({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    name: name,
    namespace: namespace,
    plural: 'catalogitems',
  });
}

export async function getK8sObject<Type extends K8sObject>({
  apiVersion,
  name,
  namespace,
  plural,
}: {
  apiVersion: string;
  name: string;
  namespace?: string;
  plural: string;
}): Promise<Type> {
  const path = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}/${name}`
    : `/apis/${apiVersion}/${plural}/${name}`;
  const resp = await apiFetch(path);
  return await resp.json();
}

export async function getResourceClaim(namespace, name): Promise<ResourceClaim> {
  return (await getNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    namespace,
    'resourceclaims',
    name
  )) as ResourceClaim;
}

export async function getResourceHandle(name: string): Promise<ResourceHandle> {
  return (await getNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourcehandles',
    name
  )) as ResourceHandle;
}

export async function getResourcePool(name: string): Promise<ResourcePool> {
  return (await getNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourcepools',
    name
  )) as ResourcePool;
}

export async function getResourceProvider(name: string): Promise<ResourceProvider> {
  return (await getNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourceproviders',
    name
  )) as ResourceProvider;
}

export async function getUserInfo(user): Promise<any> {
  const session = await getApiSession();
  const resp = await fetch(`/auth/users/${user}`, {
    headers: {
      Authentication: `Bearer ${session.token}`,
    },
  });
  return await resp.json();
}

export async function getWorkshop(namespace: string, name: string): Promise<Workshop> {
  return await getK8sObject<Workshop>({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    name: name,
    namespace: namespace,
    plural: 'workshops',
  });
}

function refreshApiSession(): void {
  window.apiSessionPromise = new Promise((resolve) => {
    fetch('/auth/session')
      .then((response) => response.json())
      .then((session) => {
        if (window.apiSessionInterval) {
          clearInterval(window.apiSessionInterval);
        }
        window.apiSessionInterval = setInterval(refreshApiSession, (session.lifetime - 60) * 1000);
        resolve(session);
      })
      .catch(() => {
        window.location.href = '/?n=' + new Date().getTime();
      });
  });
}

export async function listAnarchyActions(opt?: K8sObjectListCommonOpt): Promise<any> {
  return await listK8sObjects({
    apiVersion: 'anarchy.gpte.redhat.com/v1',
    plural: 'anarchyactions',
    ...opt,
  });
}

export async function listAnarchyGovernors(opt?: K8sObjectListCommonOpt): Promise<any> {
  return await listK8sObjects({
    apiVersion: 'anarchy.gpte.redhat.com/v1',
    plural: 'anarchygovernors',
    ...opt,
  });
}

export async function listAnarchyRuns(opt?: K8sObjectListCommonOpt): Promise<any> {
  return await listK8sObjects({
    apiVersion: 'anarchy.gpte.redhat.com/v1',
    plural: 'anarchyruns',
    ...opt,
  });
}

export async function listAnarchyRunners(opt?: K8sObjectListCommonOpt): Promise<any> {
  return await listK8sObjects({
    apiVersion: 'anarchy.gpte.redhat.com/v1',
    plural: 'anarchyrunners',
    ...opt,
  });
}

export async function listAnarchySubjects(opt?: K8sObjectListCommonOpt): Promise<any> {
  return await listK8sObjects({
    apiVersion: 'anarchy.gpte.redhat.com/v1',
    plural: 'anarchysubjects',
    ...opt,
  });
}

export async function listCatalogItems(opt?: K8sObjectListCommonOpt): Promise<CatalogItemList> {
  return (await listK8sObjects({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    plural: 'catalogitems',
    ...opt,
  })) as CatalogItemList;
}

export async function listResourceClaims(opt?: K8sObjectListCommonOpt): Promise<ResourceClaimList> {
  return (await listK8sObjects({
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    plural: 'resourceclaims',
    ...opt,
  })) as ResourceClaimList;
}

export async function listResourceHandles(opt?: K8sObjectListCommonOpt): Promise<ResourceHandleList> {
  return (await listK8sObjects({
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    namespace: 'poolboy',
    plural: 'resourcehandles',
    ...opt,
  })) as ResourceHandleList;
}

export async function listResourcePools(opt?: K8sObjectListCommonOpt): Promise<ResourcePoolList> {
  return (await listK8sObjects({
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    namespace: 'poolboy',
    plural: 'resourcepools',
    ...opt,
  })) as ResourcePoolList;
}

export async function listResourceProviders(opt?: K8sObjectListCommonOpt): Promise<ResourceProviderList> {
  return (await listK8sObjects({
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    namespace: 'poolboy',
    plural: 'resourceproviders',
    ...opt,
  })) as ResourceProviderList;
}

export async function listUsers(opt?: K8sObjectListCommonOpt): Promise<UserList> {
  return (await listK8sObjects({
    apiVersion: 'user.openshift.io/v1',
    plural: 'users',
    ...opt,
  })) as UserList;
}

export async function listWorkshops(opt?: K8sObjectListCommonOpt): Promise<WorkshopList> {
  return (await listK8sObjects({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    plural: 'workshops',
    ...opt,
  })) as WorkshopList;
}

export async function listWorkshopProvisions(opt?: K8sObjectListCommonOpt): Promise<WorkshopProvisionList> {
  return (await listK8sObjects({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    plural: 'workshopprovisions',
    ...opt,
  })) as WorkshopProvisionList;
}

export async function scalePool(resourcepool, minAvailable): Promise<any> {
  try {
    const session = await getApiSession();
    const response = await fetch(
      `/apis/poolboy.gpte.redhat.com/v1/namespaces/${resourcepool.metadata.namespace}/resourcepools/${resourcepool.metadata.name}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ spec: { minAvailable: minAvailable } }),
        headers: {
          Authentication: `Bearer ${session.token}`,
          'Content-Type': 'application/merge-patch+json',
        },
      }
    );
    return await response.json();
  } catch (err) {
    return err;
  }
}

export async function deleteAnarchyAction(anarchyAction: AnarchyAction): Promise<void> {
  await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyAction.metadata.namespace,
    'anarchyactions',
    anarchyAction.metadata.name
  );
}

export async function deleteAnarchyGovernor(anarchyGovernor: AnarchyGovernor): Promise<void> {
  await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyGovernor.metadata.namespace,
    'anarchygovernors',
    anarchyGovernor.metadata.name
  );
}

export async function deleteAnarchyRun(anarchyRun: AnarchyRun): Promise<void> {
  await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyRun.metadata.namespace,
    'anarchyruns',
    anarchyRun.metadata.name
  );
}

export async function deleteAnarchySubject(anarchySubject: AnarchySubject): Promise<void> {
  await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchySubject.metadata.namespace,
    'anarchysubjects',
    anarchySubject.metadata.name
  );
}

export async function deleteK8sObject<Type extends K8sObject>(definition: Type): Promise<Type | null> {
  const plural = definition.kind.toLowerCase() + 's';
  const path = definition.metadata.namespace
    ? `/apis/${definition.apiVersion}/namespaces/${definition.metadata.namespace}/${plural}/${definition.metadata.name}`
    : `/apis/${definition.apiVersion}/${plural}/${name}`;
  try {
    const resp = await apiFetch(path, { method: 'DELETE' });
    return await resp.json();
  } catch (error: any) {
    if (error.status === 404) {
      return null;
    } else {
      throw error;
    }
  }
}

export async function deleteResourceClaim(resourceClaim: ResourceClaim): Promise<ResourceClaim> {
  const deletedResourceClaim = (await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name
  )) as ResourceClaim;
  store.dispatch(
    apiActionDeleteResourceClaim({
      namespace: resourceClaim.metadata.namespace,
      name: resourceClaim.metadata.name,
    })
  );
  return deletedResourceClaim;
}

export async function deleteResourceHandle(resourceHandle: ResourceHandle): Promise<void> {
  await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceHandle.metadata.namespace,
    'resourcehandles',
    resourceHandle.metadata.name
  );
}

export async function deleteResourcePool(resourcePool: ResourcePool): Promise<void> {
  await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourcePool.metadata.namespace,
    'resourcehandles',
    resourcePool.metadata.name
  );
}

export async function deleteResourceProvider(resourceProvider: ResourceProvider): Promise<void> {
  await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceProvider.metadata.namespace,
    'resourcehandles',
    resourceProvider.metadata.name
  );
}

export async function deleteWorkshop(workshop: Workshop): Promise<Workshop | null> {
  return await deleteK8sObject(workshop);
}

export async function forceDeleteAnarchySubject(anarchySubject: AnarchySubject): Promise<void> {
  if ((anarchySubject.metadata.finalizers || []).length > 0) {
    await patchNamespacedCustomObject(
      'anarchy.gpte.redhat.com',
      'v1',
      anarchySubject.metadata.namespace,
      'anarchysubjects',
      anarchySubject.metadata.name,
      { metadata: { finalizers: null } }
    );
  }
  if (!anarchySubject.metadata.deletionTimestamp) {
    await deleteAnarchySubject(anarchySubject);
  }
}

export async function patchK8sObject<Type extends K8sObject>({
  apiVersion,
  jsonPatch,
  name,
  namespace,
  patch,
  plural,
}: {
  apiVersion: string;
  jsonPatch?: JSONPatch;
  name: string;
  namespace?: string;
  patch?: object;
  plural: string;
}): Promise<Type> {
  const path = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}/${name}`
    : `/apis/${apiVersion}/${plural}/${name}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(jsonPatch || patch),
    headers: {
      'Content-Type': jsonPatch ? 'application/json-patch+json' : 'application/merge-patch+json',
    },
    method: 'PATCH',
  });
  return await resp.json();
}

export async function patchResourceClaim(
  namespace: string,
  name: string,
  patch: object,
  opt: any = {}
): Promise<ResourceClaim> {
  const resourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    namespace,
    'resourceclaims',
    name,
    patch
  )) as ResourceClaim;
  if (!opt.skipUpdateStore) {
    store.dispatch(
      apiActionInsertResourceClaim({
        resourceClaim: resourceClaim,
      })
    );
  }
  return resourceClaim;
}

export async function patchResourcePool(name: string, patch: any): Promise<ResourcePool> {
  const resourcePool = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourcepools',
    name,
    patch
  )) as ResourcePool;
  return resourcePool;
}

export async function patchWorkshop({
  name,
  namespace,
  jsonPatch,
  patch,
}: {
  name: string;
  namespace: string;
  jsonPatch?: JSONPatch;
  patch?: object;
}): Promise<Workshop> {
  return patchK8sObject({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    jsonPatch: jsonPatch,
    name: name,
    namespace: namespace,
    plural: 'workshops',
    patch: patch,
  });
}

export async function patchWorkshopProvision({
  name,
  namespace,
  jsonPatch,
  patch,
}: {
  name: string;
  namespace: string;
  jsonPatch?: JSONPatch;
  patch?: object;
}): Promise<WorkshopProvision> {
  return patchK8sObject({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    jsonPatch: jsonPatch,
    name: name,
    namespace: namespace,
    plural: 'workshopprovisions',
    patch: patch,
  });
}

export async function requestStatusForAllResourcesInResourceClaim(resourceClaim): Promise<ResourceClaim> {
  const requestDate = new Date();
  const requestTimestamp: string = requestDate.toISOString().split('.')[0] + 'Z';
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  for (let i = 0; i < data.spec.resources.length; ++i) {
    if (resourceClaim.status?.resources?.[i]?.state?.status?.supportedActions?.status) {
      data.spec.resources[i].template.spec.vars.check_status_request_timestamp = requestTimestamp;
    }
  }
  const patchedResourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
  store.dispatch(
    apiActionUpdateResourceClaim({
      resourceClaim: patchedResourceClaim,
    })
  );
  return patchedResourceClaim;
}

export async function scheduleStopForAllResourcesInResourceClaim(
  resourceClaim: ResourceClaim,
  date: Date
): Promise<ResourceClaim> {
  const stopTimestamp = date.toISOString().split('.')[0] + 'Z';
  const patch = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  for (let i = 0; i < patch.spec.resources.length; ++i) {
    patch.spec.resources[i].template.spec.vars.action_schedule.stop = stopTimestamp;
  }

  const updatedResourceClaim: ResourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    patch
  )) as ResourceClaim;
  store.dispatch(
    apiActionUpdateResourceClaim({
      resourceClaim: updatedResourceClaim,
    })
  );
  return updatedResourceClaim;
}

export async function setLifespanEndForResourceClaim(resourceClaim: ResourceClaim, date: Date): Promise<ResourceClaim> {
  const endTimestamp = date.toISOString().split('.')[0] + 'Z';
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };

  if (data.spec.lifespan) {
    data.spec.lifespan.end = endTimestamp;
  } else {
    data.spec.lifespan = { end: endTimestamp };
  }

  const updatedResourceClaim: ResourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
  store.dispatch(
    apiActionUpdateResourceClaim({
      resourceClaim: updatedResourceClaim,
    })
  );
  return updatedResourceClaim;
}

export async function startAllResourcesInResourceClaim(resourceClaim: ResourceClaim): Promise<ResourceClaim> {
  const defaultRuntime = Math.min(
    ...resourceClaim.status.resources.map((r) =>
      parseDuration(r.state.spec.vars.action_schedule?.default_runtime || '4h')
    )
  );
  const startDate = new Date();
  const stopDate = new Date(Date.now() + defaultRuntime);
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  for (let i = 0; i < data.spec.resources.length; ++i) {
    data.spec.resources[i].template.spec.vars.action_schedule.start = startDate.toISOString().split('.')[0] + 'Z';
    data.spec.resources[i].template.spec.vars.action_schedule.stop = stopDate.toISOString().split('.')[0] + 'Z';
  }

  const patchedResourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
  store.dispatch(
    apiActionUpdateResourceClaim({
      resourceClaim: patchedResourceClaim,
    })
  );
  return patchedResourceClaim;
}

export async function stopAllResourcesInResourceClaim(resourceClaim): Promise<ResourceClaim> {
  const stopDate = new Date();
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  for (let i = 0; i < data.spec.resources.length; ++i) {
    data.spec.resources[i].template.spec.vars.action_schedule.stop = stopDate.toISOString().split('.')[0] + 'Z';
  }

  const patchedResourceClaim = (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
  store.dispatch(
    apiActionUpdateResourceClaim({
      resourceClaim: patchedResourceClaim,
    })
  );
  return patchedResourceClaim;
}

export async function deleteNamespacedCustomObject(group, version, namespace, plural, name): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`, {
    method: 'DELETE',
  });
  return await resp.json();
}

export async function getNamespacedCustomObject(group, version, namespace, plural, name): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`);
  return await resp.json();
}

export async function listK8sObjects(opt: K8sObjectListOpt): Promise<K8sObjectList> {
  const { apiVersion, namespace, plural } = opt;
  const urlSearchParams = new URLSearchParams();
  if (opt.continue) {
    urlSearchParams.set('continue', opt.continue);
  }
  if (opt.labelSelector) {
    urlSearchParams.set('labelSelector', opt.labelSelector);
  }
  if (opt.limit) {
    urlSearchParams.set('limit', opt.limit.toString());
  }
  const base_url = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}`
    : `/apis/${apiVersion}/${plural}`;
  const resp = await apiFetch(`${base_url}?${urlSearchParams.toString()}`, {
    disableImpersonation: opt.disableImpersonation || false,
  });
  return await resp.json();
}

export async function listNamespaces(opt?: K8sObjectListCommonOpt): Promise<NamespaceList> {
  const query_params = {};
  if (opt?.continue) {
    query_params['continue'] = opt.continue;
  }
  if (opt?.labelSelector) {
    query_params['labelSelector'] = opt.labelSelector;
  }
  if (opt?.limit) {
    query_params['limit'] = opt.limit;
  }
  const query_string = Object.keys(query_params)
    .map((k) => `${k}=${encodeURI(query_params[k])}`)
    .join('&');
  const base_url = `/api/v1/namespaces`;
  const url = query_string ? `${base_url}?${query_string}` : base_url;
  const resp = await apiFetch(url);
  return await resp.json();
}

export async function patchNamespacedCustomObject(
  group,
  version,
  namespace,
  plural,
  name,
  patch,
  patchType = 'merge'
): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    headers: {
      'Content-Type': 'application/' + patchType + '-patch+json',
    },
  });
  return await resp.json();
}

export async function getOpenStackServersForResourceClaim(resourceClaim): Promise<any> {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/servers`
  );
  return await resp.json();
}

export async function rebootOpenStackServer(resourceClaim, projectId, serverId): Promise<any> {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/reboot`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function startOpenStackServer(resourceClaim, projectId, serverId): Promise<any> {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/start`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function stopOpenStackServer(resourceClaim, projectId, serverId): Promise<any> {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function startOpenStackServerConsoleSession(resourceClaim, projectId, serverId): Promise<any> {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/console`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function updateK8sObject<Type extends K8sObject>(definition: Type): Promise<Type> {
  const plural = definition.kind.toLowerCase() + 's';
  const path = definition.metadata.namespace
    ? `/apis/${definition.apiVersion}/namespaces/${definition.metadata.namespace}/${plural}/${definition.metadata.name}`
    : `/apis/${definition.apiVersion}/${plural}/${name}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(definition),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PUT',
  });
  return await resp.json();
}

export async function updateWorkshop(workshop: Workshop): Promise<Workshop> {
  return updateK8sObject(workshop);
}
