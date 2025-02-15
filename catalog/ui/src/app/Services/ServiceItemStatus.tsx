import React from 'react';
import { useEffect, useState } from 'react';

import {
  Button,
  DescriptionList,
  DescriptionListTerm,
  DescriptionListGroup,
  DescriptionListDescription,
  Spinner,
  Split,
  SplitItem,
  Title,
} from '@patternfly/react-core';
import { BABYLON_DOMAIN } from '@app/util';
import { RedoIcon } from '@patternfly/react-icons';

const yaml = require('js-yaml');

import { K8sObject, ResourceClaim } from '@app/types';
import LocalTimestamp from '@app/components/LocalTimestamp';

export interface ServiceItemStatusProps {
  onCheckStatusRequest: () => Promise<void>;
  resourceClaim: ResourceClaim;
}

function getCheckStatusStateFromResource(resourceState: any, resourceTemplate: any): string | null {
  const resourceStateVars = resourceState.spec?.vars;
  const resourceTemplateVars = resourceTemplate.spec?.vars;
  if (resourceStateVars?.check_status_state && resourceStateVars.check_status_state != 'successful') {
    return resourceStateVars.check_status_state;
  }
  if (
    resourceTemplateVars?.check_status_request_timestamp &&
    (!resourceState?.status?.towerJobs?.status?.startTimestamp ||
      resourceState.status.towerJobs.status.startTimestamp < resourceTemplateVars.check_status_request_timestamp)
  ) {
    return 'requested';
  }
  return null;
}

const ServiceItemStatus: React.FunctionComponent<ServiceItemStatusProps> = ({
  onCheckStatusRequest,
  resourceClaim,
}) => {
  // Extract the last status check request timestamp
  const lastRequestTimestamp: string | undefined = resourceClaim.spec.resources.reduce<string | undefined>(
    (lastTimestamp, resourceSpec) => {
      const ts = resourceSpec?.template?.spec?.vars?.check_status_request_timestamp;
      if (ts) {
        if (lastTimestamp) {
          return ts > lastTimestamp ? ts : lastTimestamp;
        } else {
          return ts;
        }
      } else {
        return lastTimestamp;
      }
    },
    undefined
  );
  const lastRequestDate: number = lastRequestTimestamp ? Date.parse(lastRequestTimestamp) : null;
  const lastRequestMillisecondsAgo: number = lastRequestDate ? Date.now() - lastRequestDate : null;

  // Extract the last status completion from resource status
  const lastUpdateTimestamp: string | undefined = resourceClaim.status.resources.reduce(
    (lastTimestamp, resourceStatus) => {
      const ts = resourceStatus?.state?.status?.towerJobs?.status?.completeTimestamp;
      if (ts) {
        if (lastTimestamp) {
          return ts > lastTimestamp ? ts : lastTimestamp;
        } else {
          return ts;
        }
      } else {
        return lastTimestamp;
      }
    },
    undefined
  );
  const lastUpdateDate: number = lastUpdateTimestamp ? Date.parse(lastUpdateTimestamp) : null;
  const lastUpdateMillisecondsAgo: number = lastUpdateDate ? Date.now() - lastUpdateDate : null;

  // Possible check status states
  // - requested
  // - pending
  // - running
  const checkStatusState: string | undefined = resourceClaim.spec.resources.reduce<string | undefined>(
    (reducedCheckState, resourceSpec, idx) => {
      const resourceState = resourceClaim.status.resources[idx].state;
      const resourceCheckState = getCheckStatusStateFromResource(resourceState, resourceSpec.template);
      if (resourceCheckState === 'running' || reducedCheckState === 'running') {
        return 'running';
      } else if (resourceCheckState === 'pending' || reducedCheckState === 'pending') {
        return 'pending';
      } else if (resourceCheckState === 'requested' || reducedCheckState === 'requested') {
        return 'requested';
      }
      return undefined;
    },
    undefined
  );

  // Save refresh requested in state to immediately disable the refresh button
  const [refreshRequested, setRefreshRequested] = useState<boolean>(false);

  // Save last update timestamp as the value is lost when update begins running.
  const [saveLastUpdateTimestamp, setSaveLastUpdateTimestamp] = useState<string>(lastUpdateTimestamp);

  function requestStatusCheck(): void {
    onCheckStatusRequest();
    setRefreshRequested(true);
  }

  // Immediately request a status check if last check is over 5 minutes ago.
  useEffect(() => {
    if (lastUpdateTimestamp) {
      setSaveLastUpdateTimestamp(lastUpdateTimestamp);
    }
    if ((!checkStatusState && lastRequestMillisecondsAgo === null) || lastRequestMillisecondsAgo > 300000) {
      requestStatusCheck();
    }
  }, [lastUpdateTimestamp]);

  useEffect(() => {
    setRefreshRequested(false);
  }, [resourceClaim.metadata.resourceVersion]);

  return (
    <>
      <Split key="refresh" className="services-item-status-header">
        <SplitItem isFilled>
          <DescriptionList isHorizontal>
            <DescriptionListGroup>
              <DescriptionListTerm>Last status update</DescriptionListTerm>
              <DescriptionListDescription>
                {saveLastUpdateTimestamp ? <LocalTimestamp timestamp={saveLastUpdateTimestamp} /> : '-'}
              </DescriptionListDescription>
            </DescriptionListGroup>
          </DescriptionList>
        </SplitItem>
        <SplitItem>
          {checkStatusState ? (
            <div className="services-item-status-check-state">
              Status check {checkStatusState + ' '} <Spinner size="md" />
            </div>
          ) : null}
        </SplitItem>
        <SplitItem>
          <Button
            icon={<RedoIcon />}
            isDisabled={refreshRequested || checkStatusState ? true : false}
            onClick={requestStatusCheck}
            variant="link"
          >
            Refresh Status
          </Button>
        </SplitItem>
      </Split>
      {resourceClaim.spec.resources.map((resourceSpec, idx) => {
        const resourceStatus = resourceClaim.status?.resources[idx];
        const resourceState = resourceStatus?.state;

        if (!resourceState.status?.supportedActions?.status) {
          return null;
        }

        const componentDisplayName =
          resourceClaim.metadata.annotations?.[`${BABYLON_DOMAIN}/displayNameComponent${idx}`] ||
          resourceSpec.name ||
          resourceSpec.provider?.name;

        const resourceVars = resourceState?.spec?.vars;

        return (
          <div key={idx} className="services-item-body-resource">
            <Title headingLevel="h2" size="lg">
              {componentDisplayName}
            </Title>
            <DescriptionList isHorizontal>
              {resourceVars?.status_messages ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Status Messages</DescriptionListTerm>
                  <DescriptionListDescription>
                    <pre>{resourceVars.status_messages}</pre>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
              {resourceVars?.status_data ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Status Data</DescriptionListTerm>
                  <DescriptionListDescription>
                    <pre>{yaml.dump(resourceVars.status_data)}</pre>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
              {!resourceVars?.status_data && !resourceVars?.status_messages ? <p>Status unavailable.</p> : null}
            </DescriptionList>
          </div>
        );
      })}
    </>
  );
};

export default ServiceItemStatus;
