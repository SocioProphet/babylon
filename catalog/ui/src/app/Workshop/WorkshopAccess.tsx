import React from 'react';
import { useState } from 'react';

const yaml = require('js-yaml');

import {
  ActionGroup,
  Bullseye,
  DescriptionList,
  DescriptionListDescription,
  DescriptionListGroup,
  DescriptionListTerm,
  PageSection,
  PageSectionVariants,
  Stack,
  StackItem,
  Text,
  Title,
} from '@patternfly/react-core';
import { ExternalLinkAltIcon } from '@patternfly/react-icons';

import { WorkshopSpecUserAssignment } from '@app/types';
import { renderContent } from '@app/util';
import { WorkshopDetails } from './workshopAPI';

interface WorkshopAccessProps {
  workshop: WorkshopDetails;
}

const WorkshopAccess: React.FunctionComponent<WorkshopAccessProps> = ({ workshop }) => {
  const description: string = workshop.description;
  const displayName: string = workshop.displayName || 'Workshop';
  const [accessPassword, setAccessPassword] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const userAssignment: WorkshopSpecUserAssignment = workshop.assignment;

  return (
    <PageSection variant={PageSectionVariants.light}>
      <Stack>
        <StackItem>
          <Bullseye>
            <Title headingLevel="h2">{displayName}</Title>
          </Bullseye>
        </StackItem>
        {description ? (
          <StackItem>
            <Bullseye>{description}</Bullseye>
          </StackItem>
        ) : null}
        <StackItem>
          <Bullseye>
            <DescriptionList isHorizontal>
              {userAssignment.labUserInterface ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Lab User Interface</DescriptionListTerm>
                  <DescriptionListDescription>
                    <a href={userAssignment.labUserInterface.url} target="_blank">
                      {userAssignment.labUserInterface.url} <ExternalLinkAltIcon />
                    </a>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
              {userAssignment.messages ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Messages</DescriptionListTerm>
                  <DescriptionListDescription>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: renderContent(userAssignment.messages.replace(/\n/g, '  +\n')),
                      }}
                    />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
              {userAssignment.data ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Data</DescriptionListTerm>
                  <DescriptionListDescription>
                    <pre>{yaml.dump(userAssignment.data)}</pre>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
            </DescriptionList>
          </Bullseye>
        </StackItem>
      </Stack>
    </PageSection>
  );
};

export default WorkshopAccess;
