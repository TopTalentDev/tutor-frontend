import { MapsAPILoader } from '@agm/core';
import {
    AfterViewInit,
    ChangeDetectorRef,
    Component,
    ElementRef,
    EventEmitter,
    Inject,
    Input,
    NgZone,
    OnChanges,
    OnDestroy,
    OnInit,
    Output,
    QueryList,
    ViewChild,
    ViewChildren
} from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { MatSelectChange } from '@angular/material/select';
import { Router } from '@angular/router';
import { SocketEventData, SocketService } from 'app/lib/core/socket';
import { MomentRange } from 'app/models';
import { AddToCalendarService } from 'app/services/add-to-calendar.service';
import { AlertService } from 'app/services/alerts';
import * as moment from 'moment-timezone';
import { Subscription } from 'rxjs/Rx';
import { Auth, Backend } from '../../lib/core/auth';
import { Media } from '../../lib/core/media';
import { Availability, Subject, User } from '../../models';
import { Lesson } from '../../models/lesson';
import { TimeEntry } from '../../pages/account/calendar/interfaces';
import { AccountService } from '../../services/account';
import { MessengerFrontService } from '../../services/messenger';
import { NotificationsService } from '../../services/notifications';
import { Timezone, TimezoneService } from '../../services/timezone';
import { MicroEvents } from 'app/lib/core/common/events';
import { forkJoin } from 'rxjs';
import { filter, take } from "rxjs/operators";
import _get from 'lodash-es/get';

function timeFromDate(d: moment.Moment): TimeEntry {
    const hour = d.hour(), minute = d.minute();
    return <TimeEntry>{
        hour: hour % 12,
        minute: minute,
        pm: hour > 12 ? 1 : 0,
        full: {
            hour: hour,
            minute: minute,
        }
    };
}

@Component({
    selector: 'learnt-booking',
    templateUrl: './booking.component.html',
    styleUrls: ['./booking.component.scss']
})
export class BookingComponent implements OnInit, OnDestroy, AfterViewInit, OnChanges {
    confirmed: boolean;

    /**
     * Get the previous day.
     * @return {moment.Moment}
     */
    public get prevDay(): moment.Moment {
        return this.date.clone().add(-1, 'days');
    }

    /**
     * Get the next day.
     * @return {moment.Moment}
     */
    public get nextDay(): moment.Moment {
        return this.date.clone().add(1, 'days');
    }

    /**
     * Getter for the state of the 'book now' button.
     */
    public get bookNowDisabled(): boolean {
            console.log(this.calendarSelection);
        if (!this.calendarSelection) {
            return true;
        }

        if (this.bookingForm.get('meet').value === this.locationOffline) {
            if (this.latestLocationAddress === null || this.latestLocationAddress === undefined || this.latestLocationAddress === '') {
                return true;
            }
        }

        return this.bookingForm.invalid || this.loading;
    }

    /**
     * Specify that this component is
     * rendered from side panel
     */
    @Input() fromPanel = false;

    @Input()
    public tutor: User;

    @Input()
    public lesson: Lesson;

    @Input()
    public editing = false;

    @Output()
    public readonly done: EventEmitter<boolean> = new EventEmitter<boolean>();

    @Output()
    public readonly closed: EventEmitter<boolean> = new EventEmitter<boolean>();

    @ViewChild('search')
    public searchElementRef: ElementRef;

    @ViewChildren('hour')
    public hourElements: QueryList<ElementRef>;

    /* Booking interval, string 12h time. 08:30am, 12:30pm, etc. */
    public interval: { start: TimeEntry, end: TimeEntry };

    public loading: boolean;
    public success: boolean;
    public booked: boolean;
    public needToAcceptChanges: boolean;

    public bookingForm: FormGroup;

    public bookingFormStep: 0 | 1;

    /* Booking date */
    public date: moment.Moment;
    prevDate: moment.Moment;
    nextDate: moment.Moment;

    public today = moment();

    public calendarSelection: MomentRange;

    public userLessons: Lesson[] = [];

    /* Tutor's availability */
    public availability: Availability;

    /* Show all 24 hours */
    public fullHours = false;

    /* Duration of the lesson, in hours */
    public duration: number;

    /* Subject name */
    public subjectName: string;

    /* Complete string location from the location input */
    public latestLocationAddress = '';

    /* Class' location type. */
    public locationOnline = 2;
    public locationOffline = 4;

    /* Last 4 digits from the credit card */
    public ccNum: string;

    public showTimezoneText = false;

    public me: User;

    private tz: string;

    /* Indexes for the start & ending blocks */
    private startBlockIndex: number;
    private endBlockIndex: number;

    private payloadData: any;
    public calendarLinks: any;

    public mobile: boolean;

    private timezoneSubscription: Subscription

    isAvailableRecurrent: boolean;
    isCheckedRecurrent = false;
    occurrence = 1;
    private subs: Subscription;

    constructor(
        private auth: Auth,
        private backend: Backend,
        private formBuilder: FormBuilder,
        private mapsApiLoader: MapsAPILoader,
        private notifications: NotificationsService,
        private socket: SocketService,
        private zone: NgZone,
        @Inject('bus') private bus: MicroEvents,
        private messengerService: MessengerFrontService,
        private timezoneService: TimezoneService,
        private account: AccountService,
        private addToCalendarService: AddToCalendarService,
        private alerts: AlertService,
        private router: Router,
        media: Media,
        cd: ChangeDetectorRef
    ) {
        this.subs = new Subscription();
        this.mobile = !media.query('gt-sm');

        media.watch('gt-sm').subscribe(event => {
            this.mobile = !event.active;
            if (!cd['destroyed']) {
                cd.detectChanges();
            }
        });

        // Set the default timezone
        this.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

        this.auth.me.pipe(filter(Boolean), take(1)).subscribe((me: User) => {
            this.me = me;
            //override the default timezone with the user's preference if available
            this.tz = me.timezone;
            this.today = moment.tz(this.tz);
            if (me.card !== null) {
                this.ccNum = this.me.card.number;
            }
        });

        this.bookingForm = this.formBuilder.group({
            subject: ['', Validators.required],
            meet: ['', Validators.required],
            recurrent: [false],
            occurrence: [10]
        });

        this.bookingFormStep = 0;
    }

    onTutorUpdate(what: number) {

        if (this.bookingForm.get('meet').value === this.locationOffline &&
            !this.tutor.canMeetInPerson) {
            this.notifications.notify(
                'Tutor just updated profile',
                `${this.tutor.shortName} is available for the moment only online. Please retry the booking process.`,
                undefined,
                10000,
            );
            this.backToEdit();
        }

        const actualSubject: Subject = this.bookingForm.get('subject').value;

        if (!this.tutor.tutoring.subjects.find(s => s.subject._id === actualSubject._id)) {
            this.notifications.notify(
                'Tutor just updated profile',
                `${this.tutor.shortName} no longer have subject ${actualSubject.name} for tutoring.`,
                undefined,
                10000,
            );
            this.backToEdit();
        }

        // TODO: Check if availability changed
    }

    ngOnInit(): void {
        this.initDate()
        this.getAvailablity();
        this.bookingForm.get('subject').setValue(this.tutor.tutoring.subjects[0].subject);
        this.bookingForm.get('meet').setValue(this.locationOnline);

        this.socket.send('booking.pending', {
            tutor: this.tutor._id,
        });
    }

    getAvailablity() {
        const from = this.date.clone().utc();
        const to = this.date.clone().endOf('day').utc();
        this.loading = true;
        return forkJoin([
            this.backend.getUserAvailability(this.tutor, from, to, this.tz),
            this.backend.getLessons(from, to, null, 'all', 0, null)
        ]).subscribe(
            ([availability, data])=> {
                if (!availability) {
                    availability = new Availability([], this.tz);
                }
                this.availability = availability;
                this.userLessons = data.lessons;
                this.loading = false;
            }
        );
    }

    ngOnDestroy() {
        this.socket.send('booking.cancel', {
            tutor: this.tutor._id,
        });
        this.subs.unsubscribe();
    }

    ngOnChanges() {
        this.bookingForm.get('meet').reset()
    }

    ngAfterViewInit(): void {}

    public close(): void {
        this.closed.next(true);
    }

    onBookingSlotsSelect(range: MomentRange) {
        if (range) {
            this.calendarSelection = range;
            this.isAvailableRecurrent = this.verifyIsAvailableRecurrent();
        } else {
            this.isAvailableRecurrent = false;
        }
    }

    verifyIsAvailableRecurrent(): boolean {
        if (!this.calendarSelection || !this.calendarSelection.from || !this.calendarSelection.to) {
            return false;
        }
        const from = this.calendarSelection.from, to = this.calendarSelection.to;
        for (const slot of this.availability.slots) {
            if (from.isSameOrAfter(slot.from, 'hour') && to.isSameOrBefore(slot.to, 'hour')) {
                if (slot.occurence === 1) {
                    return true;
                }
            }
        }
        return false;
    }

    public changedLocation(selection: MatSelectChange): void {
        if (selection.value === this.locationOffline) {
            this.initGoogleLocation();
        }
    }

    public changeTimezone(): void {
        this.account.changeTimezone().subscribe((tz: Timezone) => {
            this.me.timezone = tz.zone.replace(' ', '_');
            this.date = this.date.clone().tz(this.me.timezone).startOf('day');
            this.setPrevNext();
        });
    }

    private recurrentComparableDate(t: moment.Moment): moment.Moment {
        return moment([2010, 1, 14, t.hour(), t.minute(), t.second(), t.millisecond()]).utc();
    }

    /**
     * Initialise Google maps autocomplete for location input.
     */
    public initGoogleLocation(): void {
        this.mapsApiLoader.load().then(() => {
            const autocomplete = new google.maps.places.Autocomplete(this.searchElementRef.nativeElement, {
                types: ['address']
            });

            autocomplete.addListener('place_changed', () => {
                this.zone.run(() => {
                    const place: google.maps.places.PlaceResult = autocomplete.getPlace();

                    if (place.geometry === undefined || place.geometry === null) {
                        return;
                    }

                    this.latestLocationAddress = place.formatted_address;
                });
            });
        });
    }

    /**
     * This will set the date used for the booking date in the timezone of the user
     * It sets seconds/milliseconds to 0 so booking cloning this with hour/minutes changed is always the same
     */
    private initDate(): void {
        this.date = moment.tz(this.tz).startOf('day');
        this.setPrevNext();
    }

    /**
     * call whenever this.date changes
     * @private
     */
    private setPrevNext() {
        this.prevDate = this.date.clone().subtract(1, 'day');
        this.nextDate = this.date.clone().add(1, 'day');
        this.today = moment.tz(this.tz);
    }

    /**
     * Add or subtract amount units from current booking date.
     * Returns if supposed date is in the past.
     * @param {moment.DurationInputArg1} amount
     * @param {moment.DurationInputArg2} units
     */
    public setDate(amount: moment.DurationInputArg1, units: moment.DurationInputArg2): void {
        // this.clearHourClasses();
        const now = moment.tz(this.me.timezone);
        const clone = this.date.clone().add(amount, units); // day earlier that 30 days

        // if backward a month is in the past - setting TODAY
        if (units === 'months' && clone.isBefore(now, 'day')) {
            this.initDate();
        } else {
            this.date = this.date.clone().add(amount, units);
            this.setPrevNext();
        }

        this.interval = { start: <TimeEntry>{}, end: <TimeEntry>{} };
        this.getAvailablity();
    }

    /**
     * Book the lesson.
     * @param event
     */
    public book(event: any): void {
        event.stopPropagation();
        event.preventDefault();

        if (!this.calendarSelection) {
            return;
        }

        const from = this.calendarSelection.from.clone()
        const to = this.calendarSelection.to.clone();

        this.duration = to.diff(from, 'hours', true);
        this.duration = this.duration < 0 ? this.duration + 12 : this.duration;
        this.subjectName = this.bookingForm.get('subject').value['name'];
        this.occurrence = 1;

        const payload = {
            tutor: this.tutor._id,
            student: this.me._id,
            when: from.clone().utc().toISOString(),
            duration: to.diff(from, 'minutes', true) + 'm',
            subject: this.bookingForm.get('subject').value['_id'],
            meet: this.bookingForm.get('meet').value,
            recurrent: this.bookingForm.get('recurrent').value,
        };

        if (this.latestLocationAddress !== '' && payload.meet === this.locationOffline) {
            payload['location'] = this.latestLocationAddress;
        }

        if(this.isCheckedRecurrent) {
            console.log('Formcontrol.occurrence: ' + this.bookingForm.get('occurrence').value);
            this.occurrence = this.bookingForm.get('occurrence').value;
            payload['recurrent_count'] = this.occurrence;
        }

        if (this.me.payments === null || this.me.payments === undefined || this.me.cc !== true) {

            this.bus.emit('panels.globals', {
                date: this.date,
                subject: this.subjectName,
                interval: this.interval,
                payload: payload,
            })

            this.bus.emit('panels.open.add_card', this.tutor);

            return;
        }

        this.payloadData = payload;
        this.success = true;

        console.log('payload: ' + JSON.stringify(payload));
    }

    /**
     * Check if user logged to proceed to book.
     */
    public bookAuth() {
        if (!this.me) {
            const alertRef = this.alerts.alert(
                'Authentication',
                'You need to be logged in in order to book this tutor.',
                {
                    backdropClose: false,
                    lifetime: 0,
                    buttons: [
                        { label: 'Login', result: true },
                        { label: 'Cancel', result: false },
                    ],
                    rootTabEnabled: true
                }
            );

            alertRef.result.subscribe(
                login => {
                    alertRef.dispose();
                    if (login) {
                        this.router.navigateByUrl(
                            '/account/login?redirect=' + encodeURIComponent(location.pathname.toString() + location.search)
                        );
                    }
                }
            );
        } else {
            this.bookingFormStep = 1;          
        }
    }

    /**
     * Triggered on pressing the 'add another lesson' button.
     */
    public addAnotherLesson(): void {
        if (this.fromPanel) {
            this.bus.emit('panels.open.booking', this.tutor)
            return;
        }
        
        this.loading = this.editing = this.success = this.booked = this.confirmed = false;
        this.payloadData = undefined;
        this.latestLocationAddress = '';
        this.bookingForm.reset();
    }

    /**
     * Triggered on pressing the 'message tutor' link.
     */
    public messageTutor(): void {
        this.auth.me.pipe(filter(Boolean), take(1)).subscribe((me: User) => {
            this.messengerService.createConversationWithTutor(me, this.tutor);
        });
        this.close();
    }

    /**
     * Triggered on pressing the 'back' button to edit details.
     */
    public backToEdit(): void {
        this.success = false;
        this.loading = false;
        this.bookingFormStep = 0;

        setTimeout(() => {
            if (this.bookingForm.get('meet').value === this.locationOffline) {
                this.initGoogleLocation();
            }

            // FIXME:
            // this.addBookingClasses(this.startBlockIndex, this.endBlockIndex);
        }, 500);
    }

    /**
     * Complete the booking request.
     */
    public addBooking(): void {
        this.bookRequest(this.payloadData);
    }

    /**
     * Send the lesson change request.
     */
    public editBooking(): void {
        this.loading = true;

        const payload: {
            subject?: string,
            meet?: number,
            location?: string,
            when?: string,
            ends?: string,
        } = {
            subject: (<Subject>this.bookingForm.get('subject').value)._id,
            meet: this.bookingForm.get('meet').value,
            location: this.latestLocationAddress,
        };

        const startsAt = moment(this.date).hour(this.interval.start.full.hour).minute(this.interval.start.minute);
        const endsAt = moment(this.date).hour(this.interval.end.full.hour).minute(this.interval.end.minute);

        payload.when = startsAt.utc().toISOString();
        payload.ends = endsAt.utc().toISOString();

        this.backend.proposeLessonChange(this.lesson._id, payload).subscribe(lesson => {
            this.loading = false;
            this.booked = true;
            this.needToAcceptChanges = false;
            this.done.next(true);
        }, (error: HttpErrorResponse) => {
            this.loading = false;

            const err = error.error;
            const notify = (t: string, m: string) => this.notifications.notify(t, m, 'close', 10 * 1000);

            let notifyMessage = `Encountered an issue while requesting a lesson change.`;

            if (err.error === undefined) {
                notify('Error requesting a lesson change', notifyMessage);
                return;
            }

            if (err.raw === undefined || err.raw.type === undefined) {
                notify('Error requesting a lesson change', `We couldn't request the lesson change: ${err.message}.`);
                return;
            }

            switch (<number>err.raw.type) {
                case 0: // invalid user
                    notifyMessage = `Specified user is invalid, please make sure you filled the form correctly and try again later.`;
                    break;
                case 3: // invalid time
                    notifyMessage = `Encountered an issue related to the selected time: ${err.raw.message}.`;
                    break;
                case 5: // invalid proposal
                    notifyMessage = `We couldn't request the lesson change: ${err.raw.message}`;
                    break;
                default:
                    notifyMessage = `Received an unknown error while requesting a lesson change with ${this.tutor.profile.first_name}.`;
            }

            notify('Couldn\'t request the lesson change', notifyMessage);
        });
    }

    /**
     * Post the data for the booking request.
     * @param payload
     */
    private bookRequest(payload: any): void {
        this.loading = true;
        this.subs.add(this.socket.on('notification').subscribe(event => {
            const data = event.data as SocketEventData;
            const notifData = _get(data, 'data.notification.data');
            if (_get(notifData, 'lesson.students', []).includes(payload.student) &&
                _get(notifData, 'lesson.tutor') === payload.tutor &&
                _get(notifData, 'lesson.subject') === payload.subject) {
                this.confirmed = true;
            }
        }))
        this.backend.createLesson(payload).subscribe(lesson => {
            this.lesson = lesson;
            this.booked = true;
            this.needToAcceptChanges = true;
            this.done.next(true);
            this.loading = false;

            console.log('LESSON: ' + JSON.stringify(lesson));

            const event = {
                title: `${this.subjectName} class${this.tutor ? ' with ' + this.tutor.shortName : ''}`,
                start: this.lesson.starts_at.utc().toISOString(),
                end: this.lesson.ends_at.utc().toISOString(),
                duration: this.lesson.duration,
                address: this.lesson.Online ? 'Online' : this.lesson.location
            }
            this.calendarLinks = this.addToCalendarService.generateCalendarEvent(event);

        }, (error: HttpErrorResponse) => {
            this.loading = false;
            const err = error.error;
            const notify = (t: string, m: string) => this.notifications.notify(t, m, 'close', 10 * 1000);

            let notifyMessage = `Encountered an issue while booking a lesson with ${this.tutor.profile.first_name}.`;

            if (err.error === undefined || err.raw === undefined || err.raw.type === undefined) {
                notify('Error booking a lesson', notifyMessage);
                return;
            }

            switch (<number>err.raw.type) {
                case 0: // invalid user
                    notifyMessage = `Specified user is invalid, please make sure you filled the form correctly and try again later.`;
                    break;
                case 1: // invalid role
                    notifyMessage = `Specified user is pending, please make sure you filled the form correctly and try again later.`;
                    break;
                case 2: // invalid subject
                    notifyMessage = `Specified subject does not exist, please try again later.`;
                    break;
                case 3: // invalid time
                    notifyMessage = `Encountered an issue related to the selected time: ${err.raw.message}.`;
                    break;
                case 4: // database err
                    notifyMessage = `We couldn't store the lesson in the database. `;
                    notifyMessage += `Please try again later. If it happens again, contact us immediately.`;
                    break;
                default:
                    notifyMessage = `Received an unknown error while booking a lesson with ${this.tutor.profile.first_name}.`;
            }

            notify('Couldn\'t book the lesson', notifyMessage);
        });
    }

    public isRecurring(event) {
        this.isCheckedRecurrent = event;
    }
}
