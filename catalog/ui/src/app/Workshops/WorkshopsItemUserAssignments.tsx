import React from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

const yaml = require('js-yaml');

import {
  ActionGroup,
  Button,
  CodeBlock,
  CodeBlockCode,
  DescriptionList,
  DescriptionListTerm,
  DescriptionListGroup,
  DescriptionListDescription,
  EmptyState,
  EmptyStateIcon,
  Text,
} from '@patternfly/react-core';

import { TableComposable, Thead, Tr, Th, Tbody, Td } from '@patternfly/react-table';

import { assignWorkshopUser, bulkAssignWorkshopUsers } from '@app/api';
import { Workshop, WorkshopSpecUserAssignment } from '@app/types';
import { renderContent } from '@app/util';

import BulkUserAssignmentModal from '@app/components/BulkUserAssignmentModal';
import EditableText from '@app/components/EditableText';
import LabInterfaceLink from '@app/components/LabInterfaceLink';
import LoadingIcon from '@app/components/LoadingIcon';

interface WorkshopsItemUserAssignmentsProps {
  onWorkshopUpdate: (workshop: Workshop) => void;
  workshop: Workshop;
}

const WorkshopsItemUserAssignments: React.FunctionComponent<WorkshopsItemUserAssignmentsProps> = ({
  onWorkshopUpdate,
  workshop,
}) => {
  const [bulkUserAssignmentMessage, setBulkUserAssignmentMessage] = useState<string>('');
  const [bulkUserAssignmentModalIsOpen, setBulkUserAssignmentModalIsOpen] = useState<boolean>(false);

  const haveUserNames = (workshop.spec.userAssignments || []).find((ua) => ua.userName) ? true : false;
  const resourceClaimNames = [...new Set((workshop.spec.userAssignments || []).map((ua) => ua.resourceClaimName))];

  function openBulkUserAssignmentModal(): void {
    setBulkUserAssignmentMessage('');
    setBulkUserAssignmentModalIsOpen(true);
  }

  async function bulkAssignUsers(emails: string[]) {
    const {
      workshop: updatedWorkshop,
      unassignedEmails,
      userAssignments,
    } = await bulkAssignWorkshopUsers({
      emails: emails,
      workshop: workshop,
    });
    setBulkUserAssignmentMessage(
      unassignedEmails.length === 0
        ? `Assigned ${userAssignments.length} users.`
        : `Assigned ${userAssignments.length} users. Unable to assign ${unassignedEmails.join(', ')}`
    );
    setBulkUserAssignmentModalIsOpen(false);
    onWorkshopUpdate(updatedWorkshop);
  }

  async function updateUserAssignment({
    email,
    resourceClaimName,
    userName,
  }: {
    email: string;
    resourceClaimName: string;
    userName: string;
  }): Promise<void> {
    setBulkUserAssignmentMessage('');
    const updatedWorkshop: Workshop = await assignWorkshopUser({
      email: email,
      resourceClaimName: resourceClaimName,
      userName: userName,
      workshop: workshop,
    });
    onWorkshopUpdate(updatedWorkshop);
  }

  if (!workshop.spec.userAssignments || workshop.spec.userAssignments.length === 0) {
    return (
      <EmptyState variant="full">
        <EmptyStateIcon icon={LoadingIcon} />
      </EmptyState>
    );
  }

  return (
    <>
      <BulkUserAssignmentModal
        key="bulk-user-assignment-modal"
        isOpen={bulkUserAssignmentModalIsOpen}
        onClose={() => setBulkUserAssignmentModalIsOpen(false)}
        onConfirm={(emails) => bulkAssignUsers(emails)}
      />
      <TableComposable key="users-table">
        <Thead>
          <Tr>
            {resourceClaimNames.length > 1 ? <Th>Service</Th> : null}
            {haveUserNames ? <Th>User</Th> : null}
            <Th>Assigned Email</Th>
            <Th>Details</Th>
          </Tr>
        </Thead>
        <Tbody>
          {workshop.spec.userAssignments.map((userAssignment, userAssignmentIdx) => {
            return (
              <Tr key={userAssignmentIdx}>
                {resourceClaimNames.length > 1 ? (
                  <Td>
                    <Link
                      key="services"
                      to={`/services/${workshop.metadata.namespace}/${userAssignment.resourceClaimName}`}
                    >
                      {userAssignment.resourceClaimName}
                    </Link>
                  </Td>
                ) : null}
                {haveUserNames ? <Td>{userAssignment.userName}</Td> : null}
                <Td>
                  <EditableText
                    aria-label={`Edit assignment for ${userAssignment.userName}`}
                    onChange={(email) =>
                      updateUserAssignment({
                        email: email,
                        resourceClaimName: userAssignment.resourceClaimName,
                        userName: userAssignment.userName,
                      })
                    }
                    placeholder="- unassigned -"
                    value={userAssignment.assignment?.email}
                  />
                </Td>
                <Td>
                  <DescriptionList isHorizontal>
                    {userAssignment.labUserInterface ? (
                      <DescriptionListGroup>
                        <DescriptionListTerm>Lab UI</DescriptionListTerm>
                        <DescriptionListDescription>
                          <LabInterfaceLink
                            method={userAssignment.labUserInterface.method || 'GET'}
                            url={userAssignment.labUserInterface.url}
                          />
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
                          <CodeBlock>
                            <CodeBlockCode>{yaml.dump(userAssignment.data)}</CodeBlockCode>
                          </CodeBlock>
                        </DescriptionListDescription>
                      </DescriptionListGroup>
                    ) : null}
                  </DescriptionList>
                </Td>
              </Tr>
            );
          })}
        </Tbody>
      </TableComposable>
      <ActionGroup key="users-actions">
        <Button onClick={openBulkUserAssignmentModal}>Bulk User Assignment</Button>
      </ActionGroup>
      {bulkUserAssignmentMessage ? <Text key="users-message">{bulkUserAssignmentMessage}</Text> : null}
    </>
  );
};

export default WorkshopsItemUserAssignments;
